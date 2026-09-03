# When you want more

Everything here is optional. The bot works without any of it. Come back when you
actually hit the limit, not before.

## Add a knowledge file to a project
1. Create `projects/<name>/knowledge/shipping.md` in GitHub.
2. In `projects/index.js`, add an import line and one entry in that project's file map.
3. Commit. Done.

## Turn the firewall knobs · `config.js` → `firewall`
| Switch | Default | What it does | OWASP |
|---|---|---|---|
| `blockInjections` | on | "ignore your instructions…" phrasings get a canned reply and **never reach the model** (saves neurons too) | LLM01, LLM07 |
| `stripLinks` | on | any URL not in the project's `allowedLinks` becomes `[link removed]`, after the model answers | LLM05 |
| `blockPromptLeaks` | on | if the answer contains an 8-word run from the protected part of the prompt, the answer is withheld | LLM07 |
| `llamaGuard` | **off** | runs `@cf/meta/llama-guard-3-8b` on the user's turn and on the answer. Doubles model calls. Turn on for anything public-facing with real risk | content safety |
| `maxTurns` / `maxChars` | 12 / 4000 | how much history the model sees | LLM10 |

Rate limiting per visitor lives in `wrangler.jsonc` (`ratelimits`), on by default at 30/min.

**What it does not do**, so you know: it doesn't catch every injection (nothing
does — that's why the prompt's `<boundaries>` and the leak check exist as the
second and third layers). It doesn't strip names from logs. It doesn't
authenticate anyone.

### The upgrade path (from the top-starred guardrail projects)
- **NeMo-style self-check:** a cheap yes/no call to a 1B model — "does this
  message ask the bot to ignore its rules?" — before the main call. Cheap; but
  known to flip on tiny prompt changes (NeMo issue #300). Add it as a fourth
  check in `screenInbound` if regex isn't enough for your traffic.
- **promptfoo red-team:** `npx promptfoo@latest redteam init` pointed at your
  `/api/chat`. The grown-up version of `tests/break-it.mjs`.
- **AI Gateway Guardrails:** Llama Guard at the edge, no code. `DEPLOY.md` §D.

## Put a hard ceiling on cost
Free plan: 10,000 neurons/day, then it stops. No surprise bill, no config.
Paid plan: create an AI Gateway and set a **spend limit** — `DEPLOY.md` §D.
Budget *alerts* are informational and arrive a day late. Use limits for the ceiling.

## Read what your bot has been saying (audit log)
Set up D1 per `DEPLOY.md` §F. Then:
```sql
-- What it could NOT answer. Every row is a page your website should have.
SELECT asked, COUNT(*) n FROM conversations WHERE refused = 1 GROUP BY asked ORDER BY n DESC LIMIT 40;
-- What it gets asked most. Your FAQ, written by your customers.
SELECT asked, COUNT(*) n FROM conversations GROUP BY asked ORDER BY n DESC LIMIT 40;
-- What the firewall caught.
SELECT flags, COUNT(*) n FROM conversations WHERE flags != '' GROUP BY flags ORDER BY n DESC;
```
Tell people conversations are recorded if it matters — a line in your privacy policy.

## Switch to real retrieval (Cloudflare AI Search)
When a project outgrows a few files — a whole website, hundreds of pages — bundling
into the prompt stops working. AI Search does the chunking, indexing and retrieval.
1. Create an AI Search instance in the dashboard; point it at your files / R2 / a crawl of your site.
2. Bind it in `wrangler.jsonc`: `"ai_search": [{ "binding": "SEARCH", "instance_name": "my-instance" }]`
3. In `src/gateway.js`, replace the Workers AI call with
   `env.SEARCH.get("my-instance").chatCompletions({ messages, model, ai_search_options: { retrieval: { max_num_results: 5 } } })`.
**Keep the guardrails.** Retrieval changes where the facts come from. It doesn't make the bot willing to say "I don't know."

## Two things to know about the iframe
1. Your website analytics won't see chat activity (different origin). Log from the Worker instead — better data anyway.
2. Don't build cookie sessions into it. Third-party cookies are blocked inside cross-origin iframes. Chats live in the page's localStorage, which works.

## Hide the sidebar for customers
`singleProject: true` in `config.js` shows only the default project, no sidebar. The
embed widget always behaves this way.
