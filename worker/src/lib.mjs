/* Pure helpers: encoding, session tokens, JWT verification, bundle decryption, input handling. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = {
  encode(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(str) {
    if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error("bad base64url");
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const jsonPart = (s) => JSON.parse(dec.decode(b64url.decode(s)));

// ---------------------------------------------------------------- session tokens
// v1.<base64url {"e": email, "x": expiry seconds}>.<base64url HMAC-SHA256>

const hmacKeys = new Map();
function hmacKey(secret) {
  if (!secret) throw new Error("missing session secret");
  if (!hmacKeys.has(secret)) {
    hmacKeys.set(secret, crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  }
  return hmacKeys.get(secret);
}

export async function signSession(secret, email, ttlSeconds, now = Date.now()) {
  const payload = b64url.encode(enc.encode(JSON.stringify({ e: email, x: Math.floor(now / 1000) + ttlSeconds })));
  const signed = `v1.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(signed)));
  return `${signed}.${b64url.encode(sig)}`;
}

/** Returns {email, exp} for a valid, unexpired token, otherwise null. */
export async function verifySession(secret, token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    // crypto.subtle.verify compares the MAC in constant time
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64url.decode(parts[2]), enc.encode(`v1.${parts[1]}`));
    if (!ok) return null;
    const p = jsonPart(parts[1]);
    if (typeof p.e !== "string" || typeof p.x !== "number" || p.x * 1000 <= now) return null;
    return { email: p.e, exp: p.x };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- RS256 JWT (Cloudflare Access, GitHub Actions OIDC)

const jwksCache = new Map(); // url -> { at, keys }
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;

async function jwks(url, refresh = false) {
  const hit = jwksCache.get(url);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < JWKS_TTL_MS && !(refresh && age > JWKS_MIN_REFRESH_MS)) return hit.keys;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  const keys = (await r.json()).keys;
  if (!Array.isArray(keys)) throw new Error("jwks format");
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

export function clearJwksCache() {
  jwksCache.clear();
}

/** Verifies signature, issuer, audience and time claims. Returns the claims or throws. */
export async function verifyJwt(token, { jwksUrl, issuer, audience, now = Date.now(), leeway = 60 }) {
  if (typeof token !== "string" || token.length > 8192) throw new Error("malformed");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed");
  const header = jsonPart(parts[0]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("unsupported alg");
  const find = (keys) => keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  const jwk = find(await jwks(jwksUrl)) || find(await jwks(jwksUrl, true));
  if (!jwk) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url.decode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error("bad signature");
  const c = jsonPart(parts[1]);
  const t = now / 1000;
  if (c.iss !== issuer) throw new Error("issuer");
  if (!(Array.isArray(c.aud) ? c.aud : [c.aud]).includes(audience)) throw new Error("audience");
  if (typeof c.exp !== "number" || c.exp + leeway < t) throw new Error("expired");
  if (typeof c.nbf === "number" && c.nbf - leeway > t) throw new Error("not yet valid");
  return c;
}

// ---------------------------------------------------------------- site bundle
// "FIT1" | uint16 wrapped-key length | RSA-OAEP-SHA256(AES key) | 12-byte nonce | AES-256-GCM(gzip JSON), AAD "FIT1"

export const BUNDLE_MAGIC = enc.encode("FIT1");

export function importPrivateKey(pkcs8) {
  const der = Uint8Array.from(atob(String(pkcs8).replace(/-----[^-]+-----|\s+/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
}

export async function openBundle(buf, privateKey) {
  const u = new Uint8Array(buf);
  if (u.length < 6 || !BUNDLE_MAGIC.every((b, i) => u[i] === b)) throw new Error("bundle format");
  const n = (u[4] << 8) | u[5];
  if (u.length < 6 + n + 12 + 16) throw new Error("bundle truncated");
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, u.subarray(6, 6 + n));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.subarray(6 + n, 18 + n), additionalData: BUNDLE_MAGIC }, aes, u.subarray(18 + n));
  return new Uint8Array(plain);
}

// ---------------------------------------------------------------- input handling

/** Only redirect back into the dashboard; anything else falls back to its root. */
export function safeReturnUrl(raw, siteOrigin, sitePath) {
  const fallback = siteOrigin + sitePath;
  if (typeof raw !== "string" || raw.length > 2048) return fallback;
  let u;
  try { u = new URL(raw); } catch { return fallback; }
  if (u.origin !== siteOrigin || !u.pathname.startsWith(sitePath) || u.username || u.password) return fallback;
  u.hash = "";
  return u.href;
}

export function normEmail(v) {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e) ? e : null;
}

// Strips control, bidi-override and zero-width characters and collapses whitespace.
export function cleanText(v, max) {
  if (typeof v !== "string") return "";
  return v.normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESC[c]);

export async function sha256Hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function readLimited(request, max) {
  if (Number(request.headers.get("Content-Length") || 0) > max) throw new Error("too large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error("too large"); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return dec.decode(all);
}
