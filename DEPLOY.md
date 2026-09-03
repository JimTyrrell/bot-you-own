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

## F. Logging what people ask (optional)
```bash
npx wrangler d1 create bot-you-own-logs
# paste the id into wrangler.jsonc (uncomment d1_databases), then:
npx wrangler d1 execute bot-you-own-logs --remote --file=./schema.sql
```
Read it with the two queries in `CUSTOMIZE.md`. Personal info is stripped before
storage (emails, phones, dates — not names; nothing pattern-based catches names).
