# Owner checklist — the things only you can do

Everything in this file needs your own login somewhere (Cloudflare, GitHub,
Google) or a secret only you should hold. The Worker runs fine without any of it:
each item switches on one more capability, and the code notices it's missing and
carries on. Do them in any order. Each says exactly what to click and how to
check it worked.

The account: this Worker is on **your own Cloudflare account**
(`you@example.com`). Every `wrangler` command below must run with
`CLOUDFLARE_ACCOUNT_ID=<your-account-id>` in front of it, from the
repo folder `workshops/ChatGPT/bot-you-own`. The live URL is
`https://bot-you-own.<your-subdomain>.workers.dev`.

A note on `wrangler secret put`: it reads the value from your terminal. The
`printf '…' | npx wrangler secret put NAME` form types it in one line without a
prompt. The value is never printed back and never enters git.

---

## 1. The AI Gateway (the dollar ceiling)

Why: every model call already tries to route through a Cloudflare AI Gateway
named `bot-you-own`. Until the gateway exists the call goes straight to the model
(the chip under a reply says "gateway not created yet; went direct"). Creating it
gives you logs, caching, a rate limit, and a hard spend cap, with no code change.

1. Cloudflare dashboard → **AI → AI Gateway → Create Gateway**.
2. Name it exactly `bot-you-own`. Create.
3. Open it → **Settings → Spend limit** → set a dollar ceiling (start low, say
   $5/month; you can raise it any time).

Check: send any message on the live demo, open **Under the hood → Gateway &
model**. `lastCall` should read "via gateway", not "direct (gateway missing)".

You do not touch the code: `YourBots/config.js` already has
`gateway: { id: "bot-you-own" }`.

---

## 2. The GitHub token (Commit to GitHub from the Configure screen)

Why: with this token, the Configure screen's **Commit to GitHub** button writes a
bot's folder straight into the repo, which (with Workers Builds connected)
redeploys it. Without it, that button is disabled and you Export the files by hand.

1. GitHub → your avatar → **Settings → Developer settings → Fine-grained tokens →
   Generate new token**.
2. **Repository access → Only select repositories →** `JimTyrrell/bot-you-own`.
3. **Permissions → Repository permissions → Contents → Read and write**. Nothing
   else.
4. Generate, copy the `github_pat_…` value, then:
   ```bash
   printf 'github_pat_…' | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put GITHUB_TOKEN
   ```

Check: on the live demo, **Configure** any bot — the **Commit to GitHub** button
is no longer greyed out.

---

## 3. GitHub repo secrets: BOT_URL and ADMIN_PASSPHRASE

Why: the workflow `.github/workflows/sync-library.yml` pushes documents from a
bot's `knowledge/` folder into AI Search on every commit. It needs to know the
Worker's URL and the admin code.

1. GitHub → the repo → **Settings → Secrets and variables → Actions → New
   repository secret**. Add two:
   - `BOT_URL` = `https://bot-you-own.<your-subdomain>.workers.dev`
   - `ADMIN_PASSPHRASE` = the admin code (the same value the Worker's
     `ADMIN_PASSPHRASE` secret holds — currently `under-the-hood-2026`).

Check: commit a `.md` file into any `YourBots/<bot>/knowledge/` folder; the
Action runs green, and **Under the hood → Files** lists the document.

---

## 4. Google sign-in client id (optional — a sign-in button on Plate)

Why: with a Google client id, Plate (and any food bot) shows a "Sign in with
Google" button that links a second device by proving the email. Without it, the
button simply doesn't render; email + device key and the authenticator code still
work. Microsoft and Apple are the same shape if you want them later.

1. `console.cloud.google.com` → create a project (any name).
2. **APIs & Services → OAuth consent screen** → External → fill in the app name
   and your support email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: Web application.**
4. **Authorized JavaScript origins** = `https://bot-you-own.<your-subdomain>.workers.dev`
   (add `http://localhost:8787` too if you want it in `wrangler dev`). No redirect
   URI is needed — the button uses an ID token, not a callback.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`), then either:
   ```bash
   printf '…apps.googleusercontent.com' | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put GOOGLE_CLIENT_ID
   ```
   (applies to every food bot), or put it per-bot in `project.json → food.signIn[]`.

Check: open `/apps/plate` in a fresh browser — the "Sign in with Google" button
appears on the join screen.

---

## 5. The admin's second factor (optional — a code on top of the admin login)

Why: with `ADMIN_TOTP_SECRET` set, opening "Under the hood" (and the coach page,
and `/api/admin/unlock`) asks for six digits from your authenticator app as well
as the admin code. Without it, the admin code alone opens the door.

1. In an authenticator app (Google Authenticator, 1Password, Authy) add a manual
   entry and let it generate a base32 secret, or make one yourself (16+ base32
   characters, A–Z and 2–7).
2. Put the **same** secret both in the app and in the Worker:
   ```bash
   printf 'YOURBASE32SECRET' | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put ADMIN_TOTP_SECRET
   ```

Check: **Under the hood → Settings** shows "Admin second factor: on". The admin
login now has a second field for the six digits.

Related, no secret to create: to log every admin out at once (say you shared the
code and want it rotated), bump `ADMIN_TOKEN_VERSION`:
```bash
printf '2' | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put ADMIN_TOKEN_VERSION
```

---

## 6. A custom domain (optional)

Why: serve the bot from `chat.yourdomain.com` instead of the `workers.dev` URL.

1. The domain must already be on Cloudflare (in this same account).
2. Dashboard → **Workers & Pages → bot-you-own → Settings → Domains & Routes →
   Add → Custom Domain** → e.g. `chat.designatic.com`. Pick a hostname with no
   existing record.

One warning, because it bites silently: **passkeys are tied to the hostname.** A
passkey made on `bot-you-own.<your-subdomain>.workers.dev` will not work on
`chat.designatic.com`, and vice versa. If anyone has already set up a passkey on
the current URL, they set it up again after the domain changes. Authenticator
codes and email + device key are unaffected. So add the domain **before** telling
people to make passkeys, if you can.

Check: `https://chat.yourdomain.com/health` returns `ok <version> …`.

---

## 7. The break-glass key (recommended before you set item 5)

Why: if the authenticator is lost, wiped or set up wrong, `ADMIN_TOTP_SECRET`
locks *you* out too. `ADMIN_UNLOCK_KEY` is the way back in: typed where the admin
code goes, it opens "Under the hood" with no code and no six digits, and takes you
straight to Settings to re-set the second factor.

1. Make a long random one and set it:
   ```bash
   printf "$(openssl rand -base64 24)" | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put ADMIN_UNLOCK_KEY
   ```
   (Under 16 characters it is ignored.) Keep the value somewhere the authenticator
   isn't — a password manager entry, a printed card.
2. After you ever use it: re-set `ADMIN_TOTP_SECRET` (item 5), bump
   `ADMIN_TOKEN_VERSION`, and set a **new** `ADMIN_UNLOCK_KEY`.

Check: **Under the hood → Settings** shows "Break-glass key: SET". Every use lands
in the admin record there as `admin-break-glass`.

---

## 8. The allowlist key (only if a bot uses access mode `allow`)

Why: `allow` mode lets in the emails you list (Settings → The allowlist), per bot
or for every bot. The list is encrypted; this is its key. Without it the mode
refuses everyone.

1. ```bash
   printf "$(openssl rand -base64 32)" | CLOUDFLARE_ACCOUNT_ID=<your-account-id> npx wrangler secret put ALLOWLIST_KEY
   ```
2. Under the hood → Settings → The allowlist → add the first email.

Check: the Settings allowlist section says "ALLOWLIST_KEY is set", and the address
you added is listed back to you. Rotating the key empties the list (old hashes
stop matching) — add people again.

---

## Where each secret lives

| Secret | Set by | Switches on |
|---|---|---|
| `ACCESS_PASSPHRASE` | already set | the shared passphrase (key mode) |
| `ADMIN_PASSPHRASE` | already set | "Under the hood" and the coach page |
| `GITHUB_TOKEN` | item 2 | Commit to GitHub |
| `BOT_URL`, `ADMIN_PASSPHRASE` (GitHub repo secrets) | item 3 | the library sync Action |
| `GOOGLE_CLIENT_ID` (and MICROSOFT_/APPLE_) | item 4 | a sign-in button |
| `ADMIN_TOTP_SECRET` | item 5 | the admin's six-digit second factor |
| `FOODLOG_PEPPER` | already set | hashing food-log user ids (set before real use) |
| `ADMIN_UNLOCK_KEY` | item 7 | the break-glass way into Under the hood |
| `ALLOWLIST_KEY` | item 8 | the allowlist (access mode `allow`) |

`ACCESS_PASSPHRASE_<NAME>` (per-bot keys) are optional and only needed when a bot
names its own secret in `project.json → accessKey`.
