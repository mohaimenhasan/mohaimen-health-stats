import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import worker, { NOTIFY_AUDIENCE, resetCaches } from "../src/index.mjs";
import { BUNDLE_MAGIC, b64url, clearJwksCache, safeReturnUrl, signSession, verifySession } from "../src/lib.mjs";

const enc = new TextEncoder();
const SITE = "https://site.example";
const DASH = `${SITE}/dash/`;
const WORKER = "https://fitness.example.workers.dev";
const TEAM = "team.cloudflareaccess.com";
const OWNER = "owner@example.com";
const GH = "https://token.actions.githubusercontent.com";
const WORKFLOW = "o/r/.github/workflows/access-requests.yml@refs/heads/main";
const BUNDLE = { summary: { generated: "2026-11-01" }, daily: { date: ["2026-11-01"] } };

class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.get(k)?.value ?? null; }
  async getWithMetadata(k) { const e = this.m.get(k); return { value: e?.value ?? null, metadata: e?.metadata ?? null }; }
  async put(k, value, o = {}) { this.m.set(k, { value, metadata: o.metadata ?? null, expiration: o.expiration }); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = "", limit = 1000 } = {}) {
    const keys = [...this.m.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)
      .map(([name, e]) => ({ name, metadata: e.metadata, ...(e.expiration ? { expiration: e.expiration } : {}) }));
    return { keys, list_complete: true };
  }
}

async function rsaIssuer(kid) {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return {
    jwks: { keys: [{ kty: "RSA", n: pub.n, e: pub.e, kid, alg: "RS256", use: "sig" }] },
    async sign(claims, header = {}) {
      const part = (o) => b64url.encode(enc.encode(JSON.stringify(o)));
      const now = Math.floor(Date.now() / 1000);
      const data = `${part({ alg: "RS256", kid, typ: "JWT", ...header })}.${part({ iat: now, nbf: now, exp: now + 300, ...claims })}`;
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, enc.encode(data)));
      return `${data}.${b64url.encode(sig)}`;
    },
  };
}

// Same layout as healthstats/vault.py pack()
async function sealBundle(publicKey, obj) {
  const plain = gzipSync(JSON.stringify(obj));
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, raw));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: BUNDLE_MAGIC }, aes, plain));
  return Buffer.concat([BUNDLE_MAGIC, Buffer.from([wrapped.length >> 8, wrapped.length & 255]), wrapped, nonce, ct]);
}

const access = await rsaIssuer("access-key");
const github = await rsaIssuer("github-key");
const oaep = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", oaep.privateKey)).toString("base64");
const bundleBytes = await sealBundle(oaep.publicKey, BUNDLE);

let env, calls, turnstile;
beforeEach(() => {
  resetCaches();
  clearJwksCache();
  calls = [];
  turnstile = { success: true, hostname: "site.example", action: "request-access" };
  env = {
    KV: new MemoryKV(), SESSION_SECRET: "test-session-secret", OWNER_EMAIL: "Owner@Example.com",
    SITE_ORIGIN: SITE, SITE_PATH: "/dash/", BUNDLE_URL: `${DASH}fitness.enc`, TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud-1",
    ACCOUNT_ID: "acc", LIST_ID: "list-1", CF_API_TOKEN: "cf-token", TURNSTILE_SECRET: "ts-secret", SITE_PRIVATE_KEY: pkcs8,
    GITHUB_REPO: "o/r", GITHUB_REPO_ID: "42", NOTIFY_WORKFLOW_REF: WORKFLOW,
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, method: init.method || "GET", body: init.body });
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json(access.jwks);
    if (url === `${GH}/.well-known/jwks`) return Response.json(github.jwks);
    if (url === env.BUNDLE_URL) return new Response(bundleBytes);
    if (url.startsWith("https://challenges.cloudflare.com/")) return Response.json(turnstile);
    if (url.startsWith("https://api.cloudflare.com/")) return Response.json({ success: true, result: [] });
    throw new Error(`unexpected fetch ${url}`);
  };
});

const call = (path, init = {}) => worker.fetch(new Request(new URL(path, WORKER), init), env, { waitUntil() {} });
const accessJwt = (email, claims = {}) => access.sign({ iss: `https://${TEAM}`, aud: ["aud-1"], email, ...claims });
const githubJwt = (claims = {}) => github.sign({
  iss: GH, aud: NOTIFY_AUDIENCE, repository: "o/r", repository_id: "42", workflow_ref: WORKFLOW, ref: "refs/heads/main", ...claims,
});

describe("session tokens", () => {
  test("verify round trip, tampering, wrong secret and expiry", async () => {
    const t = await signSession("s", "a@b.co", 60);
    assert.deepEqual((await verifySession("s", t)).email, "a@b.co");
    const [v, p, sig] = t.split(".");
    const forged = b64url.encode(enc.encode(JSON.stringify({ e: "owner@example.com", x: 9e9 })));
    assert.equal(await verifySession("s", `${v}.${forged}.${sig}`), null);
    assert.equal(await verifySession("other", t), null);
    assert.equal(await verifySession("s", t, Date.now() + 61_000), null);
    assert.equal(await verifySession("s", `${v}.${p}`), null);
    assert.equal(await verifySession("s", undefined), null);
  });

  test("return URLs stay inside the dashboard", () => {
    assert.equal(safeReturnUrl(`${DASH}?view=body#x`, SITE, "/dash/"), `${DASH}?view=body`);
    for (const bad of ["https://evil.example/dash/", `${SITE}/other/`, "javascript:alert(1)", "//evil.example/dash/", `https://u:p@site.example/dash/`, null]) {
      assert.equal(safeReturnUrl(bad, SITE, "/dash/"), DASH, String(bad));
    }
  });
});

describe("/auth/login", () => {
  test("requires a valid Access JWT", async () => {
    assert.equal((await call("/auth/login")).status, 401);
    const wrongAud = await accessJwt(OWNER, { aud: ["other"] });
    assert.equal((await call("/auth/login", { headers: { "Cf-Access-Jwt-Assertion": wrongAud } })).status, 401);
    const expired = await accessJwt(OWNER, { exp: Math.floor(Date.now() / 1000) - 600 });
    assert.equal((await call("/auth/login", { headers: { "Cf-Access-Jwt-Assertion": expired } })).status, 401);
    const other = await rsaIssuer("access-key"); // same kid, different key
    const forged = await other.sign({ iss: `https://${TEAM}`, aud: ["aud-1"], email: OWNER });
    assert.equal((await call("/auth/login", { headers: { "Cf-Access-Jwt-Assertion": forged } })).status, 401);
  });

  test("owner and approved viewers get a token in the URL fragment; others are refused", async () => {
    const ret = encodeURIComponent(`${DASH}?view=body`);
    const res = await call(`/auth/login?return=${ret}`, { headers: { "Cf-Access-Jwt-Assertion": await accessJwt("OWNER@example.com") } });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("Location"));
    assert.equal(`${loc.origin}${loc.pathname}${loc.search}`, `${DASH}?view=body`);
    const token = new URLSearchParams(loc.hash.slice(1)).get("auth");
    assert.equal((await verifySession(env.SESSION_SECRET, token)).email, OWNER);

    const viewer = { headers: { "Cf-Access-Jwt-Assertion": await accessJwt("friend@example.com") } };
    assert.equal((await call("/auth/login?return=https://evil.example/", viewer)).status, 403);
    await env.KV.put("user:friend@example.com", "1");
    const ok = await call("/auth/login?return=https://evil.example/", viewer);
    assert.equal(ok.status, 302);
    assert.ok(ok.headers.get("Location").startsWith(`${DASH}#auth=v1.`));
  });
});

describe("/api/data", () => {
  test("needs a session token and an approved email", async () => {
    const anon = await call("/api/data", { headers: { Origin: SITE } });
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get("Access-Control-Allow-Origin"), SITE);
    assert.ok(!calls.some((c) => c.url === env.BUNDLE_URL), "bundle is not fetched before auth");

    const viewer = await signSession(env.SESSION_SECRET, "friend@example.com", 600);
    assert.equal((await call("/api/data", { headers: { Authorization: `Bearer ${viewer}` } })).status, 403);
    await env.KV.put("user:friend@example.com", "1");
    const res = await call("/api/data", { headers: { Authorization: `Bearer ${viewer}`, Origin: SITE } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Encoding"), "gzip");
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer()))), BUNDLE);

    await env.KV.delete("user:friend@example.com"); // revoked immediately
    assert.equal((await call("/api/data", { headers: { Authorization: `Bearer ${viewer}` } })).status, 403);
  });

  test("CORS only for the dashboard origin", async () => {
    const pre = await call("/api/data", { method: "OPTIONS", headers: { Origin: SITE } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Authorization/);
    const evil = await call("/api/data", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);
  });
});

describe("/api/request", () => {
  const post = (body, origin = SITE) => call("/api/request", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const form = { name: " Sam\u202e Doe ", email: "Sam@Example.com", note: "teammate", turnstile: "tok" };

  test("stores a sanitised pending request after Turnstile passes", async () => {
    assert.equal((await post(form, "https://evil.example")).status, 403);
    assert.equal((await post({ ...form, email: "nope" })).status, 400);
    turnstile.success = false;
    assert.equal((await post(form)).status, 403);
    turnstile = { success: true, hostname: "evil.example", action: "request-access" };
    assert.equal((await post(form)).status, 403);
    assert.equal(env.KV.m.size, 0);

    turnstile.hostname = "site.example";
    const res = await post(form);
    assert.equal(res.status, 200);
    const [entry] = (await env.KV.list({ prefix: "req:" })).keys;
    assert.deepEqual({ ...entry.metadata, at: undefined }, { e: "sam@example.com", n: "Sam Doe", t: "teammate", s: 0, at: undefined });
    assert.ok(!entry.name.includes("sam"), "keys hold no email");
    const verify = calls.find((c) => c.url.includes("siteverify"));
    assert.equal(verify.body.get("secret"), "ts-secret");
  });

  test("approved viewers and oversized bodies do not create requests", async () => {
    await env.KV.put("user:sam@example.com", "1");
    assert.equal((await post(form)).status, 200);
    assert.equal((await env.KV.list({ prefix: "req:" })).keys.length, 0);
    assert.equal((await post({ ...form, note: "x".repeat(5000) })).status, 400);
  });
});

describe("/auth/admin", () => {
  const owner = async (init = {}) => ({ ...init, headers: { "Cf-Access-Jwt-Assertion": await accessJwt(OWNER), ...init.headers } });
  const postForm = async (fields, origin = WORKER) => call("/auth/admin", await owner({
    method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
  }));

  test("only the owner can open it, and request fields are escaped", async () => {
    await env.KV.put("req:abc", "1", { metadata: { e: "x@example.com", n: "<script>alert(1)</script>", t: "\"note\"", at: "2026-11-01T00:00:00Z", s: 0 } });
    const viewer = { headers: { "Cf-Access-Jwt-Assertion": await accessJwt("friend@example.com") } };
    assert.equal((await call("/auth/admin", viewer)).status, 403);
    const res = await call("/auth/admin", await owner());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Security-Policy"), /default-src 'none'/);
    const html = await res.text();
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  });

  test("approve and remove update the Access list and the allowlist", async () => {
    await env.KV.put("req:" + "0".repeat(8), "ignored");
    const reqKey = `req:${Buffer.from(await crypto.subtle.digest("SHA-256", enc.encode("sam@example.com"))).toString("hex")}`;
    await env.KV.put(reqKey, "1", { metadata: { e: "sam@example.com", n: "Sam", t: "", at: "2026-11-01T00:00:00Z", s: 1 } });

    assert.equal((await postForm({ action: "approve", email: "sam@example.com" }, "https://evil.example")).status, 403);
    assert.equal((await postForm({ action: "approve", email: OWNER })).status, 400);
    const res = await postForm({ action: "approve", email: "Sam@example.com" });
    assert.equal(res.status, 303);
    const patch = calls.find((c) => c.method === "PATCH");
    assert.equal(patch.url, "https://api.cloudflare.com/client/v4/accounts/acc/gateway/lists/list-1");
    assert.deepEqual(JSON.parse(patch.body), { append: [{ value: "sam@example.com" }] });
    assert.equal((await env.KV.getWithMetadata("user:sam@example.com")).metadata.n, "Sam");
    assert.equal(await env.KV.get(reqKey), null);

    calls = [];
    assert.equal((await postForm({ action: "remove", email: "sam@example.com" })).status, 303);
    assert.deepEqual(JSON.parse(calls.find((c) => c.method === "PATCH").body), { remove: ["sam@example.com"] });
    assert.equal(await env.KV.get("user:sam@example.com"), null);
  });
});

describe("/api/notify", () => {
  test("accepts only this repository's notifier workflow", async () => {
    assert.equal((await call("/api/notify")).status, 401);
    for (const bad of [{ workflow_ref: "o/r/.github/workflows/other.yml@refs/heads/main" }, { repository_id: "7" }, { ref: "refs/heads/dev" }, { aud: "other" }]) {
      const res = await call("/api/notify", { headers: { Authorization: `Bearer ${await githubJwt(bad)}` } });
      assert.equal(res.status, 401, JSON.stringify(bad));
    }
  });

  test("returns counts only and acknowledges up to the cursor", async () => {
    await env.KV.put("req:a", "1", { metadata: { e: "a@example.com", n: "A", t: "", at: "2026-11-01T00:00:00Z", s: 0 } });
    await env.KV.put("req:b", "1", { metadata: { e: "b@example.com", n: "B", t: "", at: "2026-11-02T00:00:00Z", s: 1 } });
    const auth = { Authorization: `Bearer ${await githubJwt()}` };
    const res = await call("/api/notify", { headers: auth });
    const body = await res.json();
    assert.deepEqual({ pending: body.pending, fresh: body.fresh }, { pending: 2, fresh: 1 });
    assert.ok(!JSON.stringify(body).includes("@"), "no emails");

    await env.KV.put("req:c", "1", { metadata: { e: "c@example.com", n: "C", t: "", at: "2999-01-01T00:00:00Z", s: 0 } });
    const ack = await call("/api/notify", { method: "POST", headers: auth, body: JSON.stringify({ cursor: body.cursor }) });
    assert.equal((await ack.json()).marked, 1);
    const after = await (await call("/api/notify", { headers: auth })).json();
    assert.equal(after.fresh, 1, "request after the cursor stays unacknowledged");
  });

  test("reports whether the site bundle opens", async () => {
    const auth = { Authorization: `Bearer ${await githubJwt()}` };
    assert.equal((await (await call("/api/notify", { headers: auth })).json()).data, true);
    resetCaches();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => (String(input) === env.BUNDLE_URL ? new Response("", { status: 404 }) : realFetch(input, init));
    assert.equal((await (await call("/api/notify", { headers: auth })).json()).data, false);
  });
});
