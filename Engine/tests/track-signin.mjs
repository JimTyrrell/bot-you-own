// The ID-token verifier, tested without Google or Microsoft: a throwaway RSA key
// signs tokens, a local HTTP server plays the provider's JWKS endpoint.
//   node Engine/tests/track-signin.mjs
import http from "node:http";
import { verifyIdToken, clearJwksCache } from "../worker/track-signin.js";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
async function makeKey(kid) {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { kp, jwk: { kty: "RSA", kid, use: "sig", alg: "RS256", n: jwk.n, e: jwk.e } };
}
async function sign(kp, kid, claims) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })), p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

const good = await makeKey("k1"), evil = await makeKey("k1");   // same kid, different key = a forged signature
const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [good.jwk] })); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const jwksUrl = `http://127.0.0.1:${server.address().port}/certs`;
const now = Date.now(), nowS = Math.floor(now / 1000);
const CLIENT = "123-abc.apps.googleusercontent.com";

const cases = [
  ["google good", "google", await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, iat: nowS, sub: "1", email: "Sam@Example.com", email_verified: true }), true, "sam@example.com"],
  ["google wrong aud", "google", await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: "someone-else", exp: nowS + 600, email: "sam@example.com", email_verified: true }), false, "wrong audience"],
  ["google expired", "google", await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS - 3600, email: "sam@example.com", email_verified: true }), false, "expired"],
  ["google bad signature", "google", await sign(evil.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: true }), false, "bad signature"],
  ["google wrong issuer", "google", await sign(good.kp, "k1", { iss: "https://evil.example", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: true }), false, "wrong issuer"],
  ["google unverified email", "google", await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: false }), false, "no verified email in token"],
  ["google tampered payload", "google", (await sign(good.kp, "k1", { iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: true })).replace(/^([^.]+)\.[^.]+/, (m, h) => `${h}.${b64u(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "mallory@example.com", email_verified: true }))}`), false, "bad signature"],
  ["microsoft good (tenant issuer)", "microsoft", await sign(good.kp, "k1", { iss: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0", tid: "9188040d-6c67-4c5b-b112-36a304b66dad", aud: CLIENT, exp: nowS + 600, preferred_username: "sam@outlook.com" }), true, "sam@outlook.com"],
  ["microsoft wrong aud", "microsoft", await sign(good.kp, "k1", { iss: "https://login.microsoftonline.com/t1/v2.0", tid: "t1", aud: "other-app", exp: nowS + 600, email: "sam@outlook.com" }), false, "wrong audience"],
  ["microsoft expired", "microsoft", await sign(good.kp, "k1", { iss: "https://login.microsoftonline.com/t1/v2.0", tid: "t1", aud: CLIENT, exp: nowS - 120, email: "sam@outlook.com" }), false, "expired"],
  ["microsoft bad signature", "microsoft", await sign(evil.kp, "k1", { iss: "https://login.microsoftonline.com/t1/v2.0", tid: "t1", aud: CLIENT, exp: nowS + 600, email: "sam@outlook.com" }), false, "bad signature"],
  ["microsoft issuer/tid mismatch", "microsoft", await sign(good.kp, "k1", { iss: "https://login.microsoftonline.com/OTHER/v2.0", tid: "t1", aud: CLIENT, exp: nowS + 600, email: "sam@outlook.com" }), false, "wrong issuer"],
  ["not a jwt", "google", "hello", false, "not a JWT"],
  ["unknown provider", "facebook", "a.b.c", false, "unknown provider"],
  ["alg none", "google", `${b64u(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64u(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, exp: nowS + 600, email: "sam@example.com", email_verified: true }))}.`, false, "unsupported algorithm"],
];

let pass = 0;
for (const [name, provider, token, wantOk, want] of cases) {
  clearJwksCache();
  const r = await verifyIdToken(token, provider, { clientId: CLIENT, jwksUrl, now });
  const ok = r.ok === wantOk && (wantOk ? r.email === want : r.reason === want);
  pass += ok ? 1 : 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  → ${r.ok ? "ok " + r.email : "refused: " + r.reason}`);
}
// The cache: one JWKS fetch serves many tokens.
let fetches = 0; const counting = (u, o) => { fetches++; return fetch(u, o); };
clearJwksCache();
for (let i = 0; i < 3; i++) await verifyIdToken(cases[0][2], "google", { clientId: CLIENT, jwksUrl, now, fetchFn: counting });
const cacheOk = fetches === 1; pass += cacheOk ? 1 : 0;
console.log(`${cacheOk ? "PASS" : "FAIL"}  jwks cached (${fetches} fetch for 3 verifications)`);
server.close();
console.log(`\n${pass}/${cases.length + 1} passed`);
process.exit(pass === cases.length + 1 ? 0 : 1);
