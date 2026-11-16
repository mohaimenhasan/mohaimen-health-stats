/*
 * Fitness data gate.
 *
 * Cloudflare Access protects every path on this Worker except /api/*.
 *   /auth/login   Access-authenticated viewers get a 7-day session token and return to the dashboard
 *   /auth/admin   owner-only page to approve, deny and remove viewers
 *   /api/data     decrypted site bundle for a valid session token
 *   /api/request  access request form (Turnstile-protected)
 *   /api/notify   pending-request counts for the notifier workflow (GitHub Actions OIDC)
 */
import { ADMIN_CSP, adminPage } from "./admin.mjs";
import {
  cleanText, importPrivateKey, normEmail, openBundle, readLimited, safeReturnUrl, sha256Hex,
  signSession, verifyJwt, verifySession,
} from "./lib.mjs";

const SESSION_TTL_S = 7 * 24 * 3600;
const REQUEST_TTL_S = 30 * 24 * 3600;
const MAX_PENDING = 100;
const BUNDLE_TTL_MS = 5 * 60 * 1000;
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const NOTIFY_AUDIENCE = "fitness-notify";

// Module scope holds only data shared by every authorised request: the decrypted bundle and the imported key.
let bundleCache = null;
let keyCache = null;

export function resetCaches() {
  bundleCache = null;
  keyCache = null;
}

const log = (level, msg, fields = {}) => console[level](JSON.stringify({ msg, ...fields }));

const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
const text = (body, status = 200) => new Response(body, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "Content-Type": "application/json" } });
const siteUrl = (env) => env.SITE_ORIGIN + env.SITE_PATH;
const ownerEmail = (env) => String(env.OWNER_EMAIL || "").trim().toLowerCase();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (url.pathname === "/auth/login") return await login(request, env, url);
      if (url.pathname === "/auth/admin") return await admin(request, env, url);
      if (url.pathname === "/") return Response.redirect(siteUrl(env), 302);
      return text("Not found", 404);
    } catch (e) {
      log("error", "unhandled", { path: url.pathname, error: String(e?.message || e) });
      const res = text("Server error", 500);
      if (url.pathname.startsWith("/api/")) withCors(res, request, env);
      return res;
    }
  },
};

// ---------------------------------------------------------------- identity

async function accessEmail(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  try {
    const c = await verifyJwt(jwt, {
      jwksUrl: `https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
      issuer: `https://${env.TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    return normEmail(c.email);
  } catch (e) {
    log("warn", "access jwt rejected", { reason: e.message });
    return null;
  }
}

async function isAllowed(env, email) {
  return email === ownerEmail(env) || (await env.KV.get(`user:${email}`)) !== null;
}

const requestKey = async (email) => `req:${await sha256Hex(email)}`;

// ---------------------------------------------------------------- /auth

async function login(request, env, url) {
  if (request.method !== "GET") return text("Method not allowed", 405);
  const email = await accessEmail(request, env);
  if (!email) return text("Unauthorized", 401);
  if (!(await isAllowed(env, email))) return text("Not approved", 403);
  const token = await signSession(env.SESSION_SECRET, email, SESSION_TTL_S);
  const dest = safeReturnUrl(url.searchParams.get("return"), env.SITE_ORIGIN, env.SITE_PATH);
  log("info", "login", { owner: email === ownerEmail(env) });
  return new Response(null, { status: 302, headers: { ...BASE_HEADERS, Location: `${dest}#auth=${token}` } });
}

async function admin(request, env, url) {
  const email = await accessEmail(request, env);
  if (!email || email !== ownerEmail(env)) return text("Forbidden", 403);

  if (request.method === "POST") {
    // Forms only come from this page; reject cross-site posts.
    if (request.headers.get("Origin") !== url.origin) return text("Forbidden", 403);
    const form = await request.formData();
    const target = normEmail(form.get("email"));
    const act = form.get("action");
    if (!target || target === ownerEmail(env)) return text("Bad request", 400);
    if (act === "approve") await approve(env, target);
    else if (act === "deny") await env.KV.delete(await requestKey(target));
    else if (act === "remove") await revoke(env, target);
    else return text("Bad request", 400);
    log("info", "admin action", { action: act });
    return new Response(null, { status: 303, headers: { ...BASE_HEADERS, Location: "/auth/admin" } });
  }
  if (request.method !== "GET") return text("Method not allowed", 405);

  const [reqs, users] = await Promise.all([env.KV.list({ prefix: "req:" }), env.KV.list({ prefix: "user:" })]);
  const pending = reqs.keys.filter((k) => k.metadata?.e)
    .map((k) => ({ email: k.metadata.e, name: k.metadata.n, note: k.metadata.t, at: k.metadata.at }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const approved = users.keys.map((k) => ({ email: k.name.slice(5), name: k.metadata?.n || "", at: k.metadata?.at }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return new Response(adminPage({ pending, users: approved, siteUrl: siteUrl(env) }), {
    // no-referrer makes browser form POSTs send Origin: null, failing the same-origin check.
    headers: { ...BASE_HEADERS, "Referrer-Policy": "same-origin", "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": ADMIN_CSP, "X-Frame-Options": "DENY" },
  });
}

async function cfApi(env, method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`cloudflare api ${method} ${r.status} ${JSON.stringify(j.errors || []).slice(0, 300)}`);
  return j.result;
}

const listPath = (env) => `/accounts/${env.ACCOUNT_ID}/gateway/lists/${env.LIST_ID}`;

async function listHas(env, email) {
  const items = await cfApi(env, "GET", `${listPath(env)}/items?per_page=1000`);
  return (items || []).flat().some((i) => String(i.value).toLowerCase() === email);
}

async function approve(env, email) {
  const key = await requestKey(email);
  const req = await env.KV.getWithMetadata(key);
  try {
    await cfApi(env, "PATCH", listPath(env), { append: [{ value: email }] });
  } catch (e) {
    if (!(await listHas(env, email))) throw e; // already on the list is fine
  }
  await env.KV.put(`user:${email}`, "1", { metadata: { n: req.metadata?.n || "", at: new Date().toISOString() } });
  await env.KV.delete(key);
}

async function revoke(env, email) {
  try {
    await cfApi(env, "PATCH", listPath(env), { remove: [email] });
  } catch (e) {
    if (await listHas(env, email)) throw e;
  }
  await env.KV.delete(`user:${email}`);
}

// ---------------------------------------------------------------- /api

function withCors(res, request, env) {
  res.headers.append("Vary", "Origin");
  if (request.headers.get("Origin") === env.SITE_ORIGIN) res.headers.set("Access-Control-Allow-Origin", env.SITE_ORIGIN);
  return res;
}

async function api(request, env, url) {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" },
    }), request, env);
  }
  let res;
  if (url.pathname === "/api/data") res = request.method === "GET" ? await data(request, env) : json({ error: "method" }, 405);
  else if (url.pathname === "/api/request") res = request.method === "POST" ? await requestAccess(request, env) : json({ error: "method" }, 405);
  else if (url.pathname === "/api/notify") res = await notify(request, env);
  else res = json({ error: "not found" }, 404);
  return withCors(res, request, env);
}

const bearer = (request) => /^Bearer ([^\s]+)$/.exec(request.headers.get("Authorization") || "")?.[1];

async function data(request, env) {
  const session = await verifySession(env.SESSION_SECRET, bearer(request));
  if (!session) return json({ error: "unauthorized" }, 401);
  if (!(await isAllowed(env, session.email))) return json({ error: "revoked" }, 403);
  const bytes = await siteBundle(env);
  return new Response(bytes.slice(), {
    headers: { ...BASE_HEADERS, "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": "private, no-store" },
    encodeBody: "manual", // body is already gzip
  });
}

async function siteBundle(env) {
  if (bundleCache && Date.now() - bundleCache.at < BUNDLE_TTL_MS) return bundleCache.bytes;
  if (!keyCache || keyCache.src !== env.SITE_PRIVATE_KEY) keyCache = { src: env.SITE_PRIVATE_KEY, key: await importPrivateKey(env.SITE_PRIVATE_KEY) };
  const r = await fetch(env.BUNDLE_URL);
  if (!r.ok) throw new Error(`bundle fetch ${r.status}`);
  const bytes = await openBundle(await r.arrayBuffer(), keyCache.key);
  bundleCache = { at: Date.now(), bytes };
  return bytes;
}

async function turnstileOk(env, token, request) {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  return j.success === true && j.hostname === new URL(env.SITE_ORIGIN).hostname && j.action === "request-access";
}

// KV metadata is capped at 1024 bytes; trim the note until the record fits.
function fitMetadata(m) {
  const size = (o) => new TextEncoder().encode(JSON.stringify(o)).byteLength;
  while (size(m) > 1000 && m.t) m.t = m.t.slice(0, -10);
  return m;
}

async function requestAccess(request, env) {
  if (request.headers.get("Origin") !== env.SITE_ORIGIN) return json({ error: "forbidden" }, 403);
  let body;
  try { body = JSON.parse(await readLimited(request, 4096)); } catch { return json({ error: "invalid" }, 400); }
  const email = normEmail(body?.email);
  const name = cleanText(body?.name, 80);
  const note = cleanText(body?.note, 200);
  if (!email || !name) return json({ error: "invalid" }, 400);
  if (!(await turnstileOk(env, body.turnstile, request))) return json({ error: "challenge" }, 403);

  // Same response whether the email is new, pending or already approved.
  if (!(await isAllowed(env, email))) {
    const key = await requestKey(email);
    const existing = await env.KV.getWithMetadata(key);
    if (existing.value === null && (await env.KV.list({ prefix: "req:", limit: MAX_PENDING })).keys.length >= MAX_PENDING) {
      log("warn", "request queue full");
    } else {
      const meta = fitMetadata({ e: email, n: name, t: note, at: new Date().toISOString(), s: existing.metadata?.s ? 1 : 0 });
      await env.KV.put(key, "1", { metadata: meta, expirationTtl: REQUEST_TTL_S });
      log("info", "access requested", { repeat: existing.value !== null });
    }
  }
  return json({ ok: true });
}

async function notify(request, env) {
  try {
    const c = await verifyJwt(bearer(request), { jwksUrl: `${GITHUB_ISSUER}/.well-known/jwks`, issuer: GITHUB_ISSUER, audience: NOTIFY_AUDIENCE });
    if (c.repository !== env.GITHUB_REPO || String(c.repository_id) !== env.GITHUB_REPO_ID
      || c.workflow_ref !== env.NOTIFY_WORKFLOW_REF || c.ref !== "refs/heads/main") throw new Error("claims");
  } catch (e) {
    log("warn", "notify rejected", { reason: e.message });
    return json({ error: "unauthorized" }, 401);
  }
  // Counts only: the repository and its Actions logs are public.
  const { keys } = await env.KV.list({ prefix: "req:" });
  const pending = keys.filter((k) => k.metadata?.e);
  if (request.method === "GET") {
    // Health check for the scheduled workflow: can the deployed bundle be opened with this Worker's key?
    let data = true;
    try { await siteBundle(env); } catch (e) { data = false; log("error", "bundle unavailable", { reason: e.message }); }
    return json({ pending: pending.length, fresh: pending.filter((k) => !k.metadata.s).length, cursor: new Date().toISOString(), data });
  }
  if (request.method !== "POST") return json({ error: "method" }, 405);
  let cursor;
  try { cursor = JSON.parse(await readLimited(request, 256)).cursor; } catch { return json({ error: "invalid" }, 400); }
  if (typeof cursor !== "string") return json({ error: "invalid" }, 400);
  let marked = 0;
  for (const k of pending) {
    if (k.metadata.s || !(k.metadata.at <= cursor)) continue;
    await env.KV.put(k.name, "1", { metadata: { ...k.metadata, s: 1 }, ...(k.expiration ? { expiration: k.expiration } : {}) });
    marked++;
  }
  return json({ ok: true, marked });
}
