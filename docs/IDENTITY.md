# Identity · `Engine/identity/`

How a person proves "it's me" to an app-shaped bot (the food log today; any kind
can use it). One folder, shared by every kind of bot, imported by the Worker.
**Never an email is sent.** Nothing here can be "reset by email", because
nothing here sends email. That is on purpose.

## The stack, in the order the join screen offers it

| # | Method | What it proves | What it does NOT prove | File |
|---|---|---|---|---|
| 1 | **Passkey** | The same person (their phone's Face ID / fingerprint / PIN) made this passkey on a device that was already in. | Anything about the email address itself. | `passkeys.js` |
| 2 | **Sign in with Google / Microsoft / Apple** | The provider vouches, with a signature we check, that this person owns that email — right now. | That they are the *same* person as before; the email is the link. | `idtoken.js` |
| 3 | **Email + device key** (always on) | Nothing about the email. It proves "this is the same browser as last time." The first device creates the log; a second device is *not* let in. | That the email is theirs. Anyone can type an email. | `devices.js` |
| 4a | **Authenticator code** (six digits) | Whoever holds the phone with the authenticator app that was set up from an already-linked device. | — | `totp.js` |
| 4b | **The owner links it** | The coach saw the code on the client's screen and typed it in, with the email. Human judgement. | — | `devices.js` |

`index.js` ties them together: `identify(request, env, bot)` answers "who is this
browser?" for one bot, and the `/api/id/*` routes do passkeys and codes. `bot` is
the bot's id — every table has a `bot` column, so two food logs on one deployment
keep their people apart (the same email is two different people).

Identity **fails closed**: a missing, malformed or unknown device key is a 401,
always. A broken check refuses; it never opens. Features fail open, identity doesn't.

## Email + device key, in plain English

- The browser makes a random 32-byte **device key** the first time the page loads,
  keeps it in `localStorage`, and sends it as `x-device-key` with every request. The
  server stores only its SHA-256.
- The user id is `SHA-256(lowercased email + FOODLOG_PEPPER + bot id)`. Set the
  pepper once: `npx wrangler secret put FOODLOG_PEPPER`. Until then the log warns and
  uses a dev value.
- A **second browser** typing a known email gets a 6-character code (letters and
  digits that survive being read aloud; expires in 7 days) and a screen with the
  other ways in. The page polls; the moment it's linked, it opens.

## Passkeys (WebAuthn)

"Set up a passkey" appears on the *This device* card once you're in. "Use a
passkey" appears on the join screen — and, where the browser supports it, in the
email field's autofill (conditional UI). Both are feature-detected
(`PublicKeyCredential`); a browser without them simply doesn't show the buttons.

What the server checks, every time (`passkeys.js`):
- registration: `clientDataJSON` type `webauthn.create`, the **challenge** we
  issued (stored in `id_challenges`, 5 minutes, used once), the **origin**, the
  `rpIdHash`, the user-present flag, then the public key is pulled out of the
  attestation object (CBOR → COSE → JWK, ES256 or RS256). The attestation
  *statement* is not verified — we're not asking "which brand of authenticator",
  only "does this key sign later". Stored: credential id, JWK, counter, bot, user.
- login: type `webauthn.get`, challenge, origin, `rpIdHash`, user-present, the
  signature over `authenticatorData ‖ SHA-256(clientDataJSON)` with WebCrypto,
  and the **counter must go up** (a cloned authenticator is refused). On success
  the *current* browser's device key is bound to that person — a passkey solves the
  second-device problem without the coach.

**The rpId caveat.** `rpId` is the host the page was served from
(`bot-you-own.<your-subdomain>.workers.dev`, say). Put the app on a custom domain later and
the rpId changes; every passkey made under the old host **stops working** and
people set up a new one. That is how WebAuthn is designed (a passkey is bound to
the site), not something this code can bend. Pick the address first.

Registration and login through a **real browser are unverified** in this release:
the verification code is covered by `Engine/tests/identity.mjs` (a node-made key
plays the authenticator, including the wrong-rpId / wrong-challenge / counter-replay
refusals) and the routes were exercised end to end with the same fake authenticator
against the dev server — but no phone has touched it yet.

## Authenticator app (TOTP, RFC 6238)

Six digits, 30-second step, ±1 step of slack, SHA-1 HMAC via WebCrypto. The secret
is 20 random bytes, base32, shown once as a QR code (drawn by
`Engine/public/id/qr.js`, no dependency) and as text. "Set up an authenticator app"
lives on the *This device* card; the person confirms with one code, and from then
on a new device is linked by typing the six digits under the email. Wrong codes go
through the same limiter as passphrase guesses (`UNLOCK_LIMITER`, 10 a minute).

### The admin's second factor

Optional. Make a secret in any authenticator app (or take one from
`node -e "import('./Engine/identity/totp.js').then(m=>console.log(m.newSecret()))"`),
scan it into the app, then `npx wrangler secret put ADMIN_TOTP_SECRET`. From then on
`/api/admin/unlock` needs `{ passphrase, code }`: the admin code alone is refused,
and the admin screens ask for the six digits too. Remove the secret to go back.

## Sign in with Google / Microsoft / Apple

Each button shows only when the bot has a client id (`project.json → food.signIn[]`
or the `GOOGLE_CLIENT_ID` / `MICROSOFT_CLIENT_ID` / `APPLE_CLIENT_ID` secret).
`idtoken.js` checks the ID token the proper way — RS256 signature against the
provider's published keys, issuer, audience, expiry, verified email — and binds the
device to the email it names. Set-up steps are in `docs/FOOD-LOG.md`. Facebook is
not here: it hands out an access token, not an ID token, which is a different check.

## Under the hood

Tables (`Engine/schema.sql`, created on first use): `id_users`, `id_devices`,
`id_pending`, `id_passkeys`, `id_challenges`, `id_totp`. Every one has a `bot`
column. Under the hood → Settings lists, per bot, which methods are on.
Tests: `node Engine/tests/identity.mjs` (ID tokens, TOTP vectors from RFC 6238
Appendix B, the CBOR decoder, passkey verification and its refusals, the QR encoder).
