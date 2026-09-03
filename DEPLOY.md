# Deploying — the button, the terminal, and the gateway

## A. The button (attendees)
Public GitHub repo → README button → Cloudflare copies it into your account,
builds, deploys. Requirements (from Cloudflare's docs): the repo is **public**, on
github.com or gitlab.com, and `wrangler.jsonc` has defaults for every binding.
That's why the optional bindings in this repo are commented out.

Every later change = edit a file in GitHub → Commit. Cloudflare rebuilds in about a minute.

## B. The terminal (Jim)
```bash
npm install
npx wrangler login              # once
npx wrangler dev                # http://localhost:8787
node tests/break-it.mjs         # in a second terminal — the break-it set
npx wrangler deploy             # → https://bot-you-own.<subdomain>.workers.dev
```

## B2. Lock it (recommended for the demo)
```bash
printf 'your passphrase here' | npx wrangler secret put ACCESS_PASSPHRASE
```
Local dev reads it from `.dev.vars` (`ACCESS_PASSPHRASE=…`). The test runner takes
`--passphrase "…"` or the `BYO_PASSPHRASE` env var. Delete the secret to reopen the bot.
What it is: `/api/unlock` turns the passphrase into an HMAC token; `/api/chat` and
the full `/api/config` require that token in an `x-access-token` header. It is a
gate against strangers and scripts, not user accounts — everyone shares one phrase.

## B2b. Access modes
`config.js` → `access.mode`: `open` · `key` · `email` · `key+email`. `key` needs the
secret from B2 (without it the bot runs open and logs a warning). `email` needs
nothing; the runner takes `--email you@example.com`. If you already created the D1
table before v2.2, add the column: `ALTER TABLE conversations ADD COLUMN visitor TEXT;`

## B3. The admin code (Under the hood)
```bash
printf 'your admin code' | npx wrangler secret put ADMIN_PASSPHRASE
```
Local: add `ADMIN_PASSPHRASE=…` to `.dev.vars`. An admin token also unlocks chat,
so you don't need both codes. Endpoints: `POST /api/admin/unlock`,
`GET /api/admin/engine?project=…`, `GET /api/admin/source?name=engine/prompt.js`.
The source snapshot in `public/engine/` is produced by `scripts/snapshot-src.mjs`
before every dev/deploy (`build.command` in `wrangler.jsonc`) and is git-ignored;
`run_worker_first` keeps `/engine/*` behind the gate.

## B4. Versioning
Bump `VERSION`, commit, deploy. `public/version.json` is generated at build with
`{version, builtAt, commit}`; `/health` returns `ok 2.1.0 <commit> <builtAt>`.

## C. Your own domain
Dashboard → Workers & Pages → the Worker → Settings → Domains & Routes → Add →
Custom Domain → `chat.yourdomain.com`. The domain has to be on Cloudflare. Pick
a hostname that doesn't already have a record.

## D. The gateway (the dollar ceiling) — do this the day you go paid
1. Dashboard → **AI → AI Gateway → Create Gateway**. Name it `bot-you-own`.
2. In `config.js`: `gateway: { id: "bot-you-own", ... }`. Commit.
3. In the gateway's settings, turn on:
   - **Spend limit** — a dollar budget per day/month that *blocks* requests past it. $5/day is generous for an FAQ bot. (Alerts are not caps; use limits for the ceiling, alerts for the warning.)
   - **Rate limiting** — requests per minute per gateway.
   - **Guardrails** — Cloudflare runs Llama Guard on prompts and responses at the edge. Set categories to Flag (log) or Block. A blocked request shows in the chat as "blocked at the gateway".
   - **Logs** — every request, with tokens and cost.
   - **Caching** (optional) — set `cacheTtl` in `config.js` to cache identical questions.

Nothing in the code changes when you flip these. That's the point of a gateway.

## E. Other models (optional)
Workers AI needs no key and is the default. To use OpenAI or Anthropic instead:
```bash
npx wrangler secret put OPENAI_API_KEY      # or ANTHROPIC_API_KEY
```
then in `config.js`: `provider: "openai", model: "gpt-4.1-mini"` or
`provider: "anthropic", model: "claude-opus-5"`. Set `gateway.accountId` too if you
want those calls to go through AI Gateway (recommended: the spend cap applies).

## F. The audit log (on by default)
`wrangler.jsonc` binds a D1 database called `bot-you-own-logs`. The Deploy button
creates one in the attendee's account; from the terminal, `npx wrangler d1 create
bot-you-own-logs` once and paste the id. No schema step: the Worker runs
`CREATE TABLE IF NOT EXISTS` on first use. Read it under the hood → Audit, or with
the queries in `CUSTOMIZE.md`. Personal info is stripped before storage (emails,
phones, dates — not names). Remove the binding to log only to Workers Logs.
