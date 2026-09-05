// ============================================================================
//  IDENTITY — one front door, shared by every kind of bot.
//
//  identify(request, env, bot) answers "who is this browser?" for a bot:
//    { keyHash, user | null, pending | null }
//  The methods, in the order the join screen offers them (docs/IDENTITY.md):
//    1. passkey                (passkeys.js)  — the phone's own lock, proves it's the same person
//    2. Google/Microsoft/Apple (idtoken.js)   — the provider proves the email
//    3. email + device key     (devices.js)   — always on; the first device just joins
//    4. a second device:  authenticator code (totp.js)  or  the owner's link (devices.js)
//  Routes here, all JSON, device key in x-device-key, the bot id in the body:
//    POST /api/id/passkey/register/options   {bot}                         → options for navigator.credentials.create
//    POST /api/id/passkey/register           {bot, challenge, id, response} → { ok }
//    POST /api/id/passkey/login/options      {bot}                         → options for navigator.credentials.get
//    POST /api/id/passkey/login              {bot, challenge, id, response} → { linked: true } (this device is bound)
//    POST /api/id/totp/setup                 {bot}                         → { secret, uri }  (known device only)
//    POST /api/id/totp/confirm               {bot, code}                   → { ok }
//    POST /api/id/totp/link                  {bot, email, code}            → { linked: true } (an unknown device, six digits)
//    GET  /api/id/methods?bot=<id>                                          → what's on for this bot, and for this device
//    POST /api/id/join                       {bot, email}                  → { linked: true, email } (first device, or a second one
//                                                                            inside the return window — devices.js)
//                                                                            or { linked: false, code, email } (a second device: the
//                                                                            owner links it with the code, or a passkey / six digits do)
//    GET  /api/id/me?bot=<id>                                               → { linked, email } or { linked: false, pending: {code, email} }
//  join/me are what a CHAT bot in "email" mode uses (Engine/worker/index.js); Plate has its
//  own join under /api/apps/<id>/ because it also creates the person's targets row.
//  Never an email is sent. Nothing here can be "reset by email".
// ============================================================================

import { deviceHash, userForDevice, userById, userByEmail, pendingFor, bindDevice, cleanEmail, ensureIdentitySchema, nowIso, deviceCount, join as joinDevice, linkByCode, touch, cleanGrace, DEFAULT_GRACE_MINUTES } from "./devices.js";
export { linkByCode, cleanGrace, DEFAULT_GRACE_MINUTES };
import { verifyRegistration, verifyAssertion, randomChallenge } from "./passkeys.js";
import { newSecret, totp, verifyTotp, otpauthUri } from "./totp.js";

export { verifyIdToken, SIGNIN_PROVIDERS } from "./idtoken.js";
export { totp, verifyTotp };

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// Who is this browser, for this bot? Fails closed: no key, malformed key, unknown key → user null.
// A known person gets their last_seen bumped: that is what the return window measures.
export async function identify(request, env, bot) {
  await ensureIdentitySchema(env);
  const keyHash = await deviceHash(request);
  const user = keyHash ? await userForDevice(env, bot.id, keyHash) : null;
  if (user) touch(env, user);
  const pending = user ? null : await pendingFor(env, bot.id, keyHash);
  return { keyHash, user, pending };
}

// The return window for a bot: the bot's own number, else the deployment's (settings), else 60.
export function graceMinutesFor(bot, globalMinutes) {
  const own = bot?.identity?.graceMinutes;
  return cleanGrace(own !== undefined && own !== null && own !== "" ? own : globalMinutes);
}

// The methods a bot has switched on. What the join screen draws, and what Settings lists.
export function signInMethods(bot, env = {}) {
  const f = bot.food || {};
  const providers = (Array.isArray(f.signIn) ? f.signIn : []).map((s) => ({ provider: s.provider, clientId: s.clientId || env[`${String(s.provider).toUpperCase()}_CLIENT_ID`] || "" })).filter((s) => s.clientId);
  return {
    passkeys: f.passkeys !== false,
    providers,                                  // [{ provider, clientId }] — only the ones with a client id
    device: true,                               // email + device key: always
    totp: f.totp !== false,
    ownerLink: true,                            // the coach's / owner's code
  };
}

// rpId for WebAuthn = the host the page was served from. A custom domain later
// changes it, and every passkey made under the old host stops working — that is
// how WebAuthn is designed, not a bug here (docs/IDENTITY.md).
function rpOf(request) { const u = new URL(request.url); return { id: u.hostname, origin: u.origin }; }

// --- The admin's second factor. ADMIN_TOTP_SECRET set → /api/admin/unlock needs {passphrase, code}.
export const adminNeedsCode = (env) => Boolean(env.ADMIN_TOTP_SECRET);
export async function adminCodeOk(env, code) {
  if (!env.ADMIN_TOTP_SECRET) return true;
  try { return (await verifyTotp(env.ADMIN_TOTP_SECRET, String(code || ""), { window: 1 })).ok; } catch { return false; }
}

// --- The routes. `bot` is already resolved by the caller; `allowed` is the rate limiter. ----
export async function handleIdentity(request, env, url, { bot, allowed = async () => true, unlockAllowed = async () => true, graceMinutes = DEFAULT_GRACE_MINUTES }) {
  if (!env.DB) return json({ error: "Identity needs the D1 database (wrangler.jsonc → d1_databases)." }, 503);
  await ensureIdentitySchema(env);
  const path = url.pathname.slice("/api/id/".length);
  const methods = signInMethods(bot, env);
  const keyHash = await deviceHash(request);
  const me = keyHash ? await userForDevice(env, bot.id, keyHash) : null;

  if (path === "methods") {
    let totpSet = false, passkeys = 0;
    if (me) {
      totpSet = Boolean((await env.DB.prepare(`SELECT confirmed FROM id_totp WHERE user_id = ?`).bind(me.id).first())?.confirmed);
      passkeys = (await env.DB.prepare(`SELECT COUNT(*) n FROM id_passkeys WHERE user_id = ?`).bind(me.id).first())?.n || 0;
    }
    return json({ bot: bot.id, ...methods, providers: methods.providers.map((p) => p.provider), me: me ? { totp: totpSet, passkeys, devices: await deviceCount(env, me.id) } : null });
  }
  if (path === "me") {
    if (me) return json({ linked: true, email: me.email });
    const pending = keyHash ? await pendingFor(env, bot.id, keyHash) : null;
    return json({ linked: false, pending: pending ? { code: pending.code, email: pending.email } : null });
  }
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!keyHash) return json({ error: "no device key", reason: "This browser didn't send a device key. Reload the page." }, 400);
  if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Too many tries. Give it a minute." }, 429);
  let body = {}; try { body = (await request.json()) || {}; } catch {}
  const rp = rpOf(request);

  try {
    // ---- JOIN: email + this device. The first device just joins; a second one waits for a link. ----
    if (path === "join") {
      const email = cleanEmail(body.email);
      if (!email) return json({ error: "email", reason: "That doesn't look like an email address." }, 400);
      if (me && me.email !== email) return json({ error: "different person", reason: "This browser is already linked to a different email. Sign out first." }, 409);
      const r = await joinDevice(env, bot.id, { email, keyHash, graceMinutes });
      if (r.linked) return json({ ok: true, linked: true, email: r.user.email, fresh: Boolean(r.fresh), ...(r.grace ? { grace: true } : {}) });
      return json({ ok: true, linked: false, code: r.code, email: r.email, reason: "This email is already in use on another device. The owner can link this one with the code." });
    }

    // ---- PASSKEYS ------------------------------------------------------------------
    if (path.startsWith("passkey/")) {
      if (!methods.passkeys) return json({ error: "passkeys are off for this bot" }, 404);
      if (path === "passkey/register/options") {
        if (!me) return json({ error: "unknown device", reason: "Join with your email first; then set up a passkey." }, 401);
        const challenge = await newChallenge(env, bot.id, "register", { userId: me.id, keyHash });
        return json({
          challenge, rp: { id: rp.id, name: bot.name }, user: { id: me.id, name: me.email, displayName: me.email },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" }, attestation: "none", timeout: 120000,
          excludeCredentials: ((await env.DB.prepare(`SELECT credential_id FROM id_passkeys WHERE user_id = ?`).bind(me.id).all()).results || []).map((r) => ({ type: "public-key", id: r.credential_id })),
        });
      }
      if (path === "passkey/register") {
        if (!me) return json({ error: "unknown device" }, 401);
        const c = await takeChallenge(env, bot.id, "register", body.challenge);
        if (!c || c.user_id !== me.id) return json({ error: "refused", reason: "That request expired or wasn't yours. Try again." }, 401);
        const v = await verifyRegistration({ clientDataJSON: body.response?.clientDataJSON, attestationObject: body.response?.attestationObject, expectedChallenge: c.challenge, expectedOrigin: rp.origin, rpId: rp.id });
        if (!v.ok) { console.warn("passkey register refused", v.reason); return json({ error: "refused", reason: `Passkey refused: ${v.reason}.` }, 401); }
        await env.DB.prepare(`INSERT OR REPLACE INTO id_passkeys (credential_id, bot, user_id, public_key, alg, counter, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(v.credentialId, bot.id, me.id, JSON.stringify(v.publicKey), v.alg, v.counter, String(body.label || "passkey").slice(0, 60), nowIso()).run();
        console.log(JSON.stringify({ event: "passkey-registered", bot: bot.id, userId: me.id.slice(0, 8), alg: v.alg }));
        return json({ ok: true, credentialId: v.credentialId, alg: v.alg });
      }
      if (path === "passkey/login/options") {
        const challenge = await newChallenge(env, bot.id, "login", { keyHash });
        return json({ challenge, rpId: rp.id, userVerification: "preferred", timeout: 120000, allowCredentials: [] });
      }
      if (path === "passkey/login") {
        const c = await takeChallenge(env, bot.id, "login", body.challenge);
        if (!c || c.key_hash !== keyHash) return json({ error: "refused", reason: "That request expired or came from another browser. Try again." }, 401);
        const row = await env.DB.prepare(`SELECT * FROM id_passkeys WHERE credential_id = ? AND bot = ?`).bind(String(body.id || ""), bot.id).first();
        if (!row) return json({ error: "refused", reason: "No passkey with that id here." }, 401);
        let publicKey; try { publicKey = JSON.parse(row.public_key); } catch { return json({ error: "refused", reason: "stored key unreadable" }, 401); }
        const v = await verifyAssertion({ clientDataJSON: body.response?.clientDataJSON, authenticatorData: body.response?.authenticatorData, signature: body.response?.signature, expectedChallenge: c.challenge, expectedOrigin: rp.origin, rpId: rp.id, publicKey, alg: row.alg, storedCounter: Number(row.counter) || 0 });
        if (!v.ok) { console.warn("passkey login refused", v.reason); return json({ error: "refused", reason: `Passkey refused: ${v.reason}.` }, 401); }
        const user = await userById(env, bot.id, row.user_id);
        if (!user) return json({ error: "refused", reason: "That passkey's person is gone." }, 401);
        if (me && me.id !== user.id) return json({ error: "different person", reason: "This browser is already linked to a different email." }, 409);
        await env.DB.prepare(`UPDATE id_passkeys SET counter = ?, last_used = ? WHERE credential_id = ?`).bind(v.counter, nowIso(), row.credential_id).run();
        await bindDevice(env, bot.id, { userId: user.id, email: user.email, keyHash, label: "linked with a passkey" });
        console.log(JSON.stringify({ event: "passkey-login", bot: bot.id, userId: user.id.slice(0, 8) }));
        return json({ ok: true, linked: true, userId: user.id, email: user.email });
      }
    }
    // ---- AUTHENTICATOR APP (TOTP) ---------------------------------------------------
    if (path.startsWith("totp/")) {
      if (!methods.totp) return json({ error: "authenticator codes are off for this bot" }, 404);
      if (path === "totp/setup") {
        if (!me) return json({ error: "unknown device", reason: "Join with your email first." }, 401);
        // A confirmed authenticator is never replaced by accident: a second device pressing
        // "Set up" would otherwise silently break the codes on the phone that already works.
        // The page sends { replace: true } only after the person has said so.
        const have = await env.DB.prepare(`SELECT confirmed FROM id_totp WHERE user_id = ?`).bind(me.id).first();
        if (have?.confirmed && body.replace !== true) return json({ error: "already set up", confirmed: true, reason: "An authenticator app is already set up for this email. Replacing it stops the old app's codes working." }, 409);
        const secret = newSecret();
        await env.DB.prepare(`INSERT OR REPLACE INTO id_totp (user_id, bot, secret, confirmed, created_at) VALUES (?, ?, ?, 0, ?)`).bind(me.id, bot.id, secret, nowIso()).run();
        return json({ ok: true, secret, uri: otpauthUri({ secret, label: me.email, issuer: bot.name }) });
      }
      if (path === "totp/confirm") {
        if (!me) return json({ error: "unknown device" }, 401);
        const row = await env.DB.prepare(`SELECT secret FROM id_totp WHERE user_id = ?`).bind(me.id).first();
        if (!row) return json({ error: "not set up", reason: "Press Set up first." }, 400);
        if (!(await unlockAllowed(env, request))) return json({ error: "rate-limited", reason: "Too many codes. Wait a minute." }, 429);
        const v = await verifyTotp(row.secret, body.code);
        if (!v.ok) return json({ error: "wrong code", reason: "That code didn't match. Check the phone's clock and try the next one." }, 401);
        await env.DB.prepare(`UPDATE id_totp SET confirmed = 1 WHERE user_id = ?`).bind(me.id).run();
        return json({ ok: true, confirmed: true });
      }
      if (path === "totp/link") {
        if (me) return json({ ok: true, linked: true, userId: me.id, email: me.email });       // already in
        if (!(await unlockAllowed(env, request))) return json({ error: "rate-limited", reason: "Too many codes. Wait a minute." }, 429);
        const email = cleanEmail(body.email);
        if (!email) return json({ error: "email", reason: "That doesn't look like an email address." }, 400);
        const user = await userByEmail(env, bot.id, email);
        const row = user ? await env.DB.prepare(`SELECT secret, confirmed FROM id_totp WHERE user_id = ?`).bind(user.id).first() : null;
        // One answer for "no such person", "no authenticator" and "wrong code": nothing to learn from it.
        const v = row?.confirmed ? await verifyTotp(row.secret, body.code) : { ok: false };
        if (!v.ok) return json({ error: "wrong code", reason: "That code didn't match, or this email has no authenticator set up." }, 401);
        await bindDevice(env, bot.id, { userId: user.id, email, keyHash, label: "linked with an authenticator code" });
        console.log(JSON.stringify({ event: "totp-link", bot: bot.id, userId: user.id.slice(0, 8) }));
        return json({ ok: true, linked: true, userId: user.id, email });
      }
    }
  } catch (err) {
    console.error("identity request failed — refusing", err?.message || err);
    return json({ error: "refused", reason: "Something went wrong checking that. Nothing was linked." }, 401);
  }
  return json({ error: "not found" }, 404);
}

async function newChallenge(env, bot, kind, { userId = null, keyHash = null } = {}) {
  const challenge = randomChallenge();
  await env.DB.prepare(`DELETE FROM id_challenges WHERE expires_at < ?`).bind(nowIso()).run();
  await env.DB.prepare(`INSERT INTO id_challenges (challenge, bot, kind, user_id, key_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(challenge, bot, kind, userId, keyHash, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()).run();
  return challenge;
}
// A challenge is answered once: read it, delete it, and only honour it if it hasn't expired.
async function takeChallenge(env, bot, kind, challenge) {
  challenge = String(challenge || "");
  if (!challenge) return null;
  const row = await env.DB.prepare(`SELECT * FROM id_challenges WHERE challenge = ? AND bot = ? AND kind = ?`).bind(challenge, bot, kind).first();
  if (row) await env.DB.prepare(`DELETE FROM id_challenges WHERE challenge = ?`).bind(challenge).run();
  return row && row.expires_at > nowIso() ? row : null;
}
