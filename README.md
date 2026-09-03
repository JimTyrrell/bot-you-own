# The Bot You Own

A ChatGPT-style assistant that runs **on your own domain, in your own Cloudflare
account, from code you can read** — for a few dollars a month, usually zero.

Not a custom GPT. Not a $99-a-month rental. Yours.

**You will not open a terminal. You will not install anything.** If you can use
a browser and edit a document, you can do this.

It is built from three layers, and the workshop teaches them in this order:

| Layer | Where | What it is |
|---|---|---|
| **1. The Prompt** | `prompt/*.md` | A ChatGPT-grade system prompt in plain Markdown: identity, date, tone, formatting, honesty, boundaries, the jobs. Your project's instructions sit on top. `engine/prompt.js` only stitches the files together. |
| **2. The Data** | `projects/` | **Projects** — the same shape as a ChatGPT Project or a custom GPT: `instructions.md` + `knowledge/` files + starter prompts. Four samples ship so you can test before you type. |
| **3. The Firewall + Gateway** | `engine/firewall.js` · `engine/gateway.js` | What stops it doing what it shouldn't. Enforced in code (link allowlist, injection screen, leak detection, rate limit) and at the edge (AI Gateway: dollar spend cap, logs, Guardrails). |

---

## What you edit, and what you don't
| | Folder / file | What's in it | Who touches it |
|---|---|---|---|
| **Yours** | `config.js` | model, who can use it, firewall switches, looks | you, once |
| **Yours** | `projects/<name>/` | one bot: `project.json` + `instructions.md` + `knowledge/` (drop files in) | you, often |
| **Yours** | `prompt/` | how every bot behaves: personality, formatting, boundaries, the jobs — plain Markdown | you, when the voice needs tuning |
| Engine | `engine/` | the Worker, the prompt assembler, the firewall, the gateway | nobody, unless you want to |
| Engine | `public/` `scripts/` `tests/` `wrangler.jsonc` | the page, the build stamp, the break-it set, Cloudflare config | nobody |

Everything in **Yours** is text. Edit it in GitHub, commit, and the bot updates
in about a minute. Nothing in **Engine** needs to change to launch a bot.

**One rule to remember:** a file at the root is global; the same file inside a
bot's folder applies to that bot only, and wins. `prompt/3-personality.md` is
every bot's voice; `projects/brightside-dental/prompt/3-personality.md` is the
dental bot's.

## Deploy it (three minutes, no card)

<!-- TODO Jim: replace USER/REPO once the GitHub repo exists, then check the button renders. -->
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/USER/REPO)

Click it. You need two free accounts — **GitHub** (where your copy of this code
lives) and **Cloudflare** (where it runs). Cloudflare copies this project into
your GitHub, builds it, and puts it on the internet.

You'll get a URL like `bot-you-own.your-name.workers.dev`. Open it. You'll see a
ChatGPT-style page with four projects in the sidebar. Try each one. Then try to
break them — that's the point of the samples.

---

## Make it yours — four steps

### 1. Make a project · `projects/`
Copy `projects/_template/` to `projects/my-business/`. Fill in three things:
- `project.json` — name, greeting, starter prompts, which job it does (`mode`), the
  links it's allowed to share, and where to send people when it can't help.
- `instructions.md` — what you'd have typed into ChatGPT's Instructions box. Paste it raw.
- `knowledge/` — what you'd have uploaded as files. Markdown or plain text.

Then set `defaultProject: "my-business"` in `config.js`. Nothing to register: the
build finds every folder in `projects/`. **Read `projects/README.md`.**

> **The single highest-value hour you will spend on this:** go into your sent
> folder and find the emails where you answered the same question for the tenth
> time. Paste those in. Your words, already tested on real customers.

### 2. Pick the job · `project.json` → `mode`
`assistant` · `answer` ⭐ · `intake` · `booking` · `concierge` · `internal` · `imported`.
**Read `MODES.md`, then start with `answer`.** One project = one job. Want two
jobs? Make two projects; the sidebar shows both.

### 3. Pick how much it's allowed to know · `project.json` → `grounding`
- `"strict"` — it answers **only** from your files and hands off otherwise. For anything customer-facing.
- `"open"` — it behaves like ChatGPT, using your files first when they apply. For yourself and your team.

### 4. Put it on your website · `public/widget.js`
One script tag. Inline or bubble. See `https://YOUR-BOT-URL/embed-example`.
```html
<div data-mybot style="height:640px"></div>
<script src="https://YOUR-BOT-URL/widget.js" async data-project="my-business"></script>
```

---

## Building a bot the ChatGPT way (no files at all)
With the admin code, **✎ Configure** opens the same screen ChatGPT's GPT builder
has: Name, Description, Instructions, Conversation starters, Knowledge (Upload
files), Capabilities — with a live **Preview** chat on the right that talks to
your unsaved draft. **Save** stores it in your bot's database and it is live at
once. **Export files** shows the folder to put in GitHub when you want the
version you own in the repo. A saved copy overrides the folder with the same
name; remove it and the folder is live again. **✎ New bot** in the sidebar starts
a blank one.

| ChatGPT's builder | Here |
|---|---|
| Name · Description · Instructions · Conversation starters | the same fields |
| Knowledge → Upload files | Upload files (text: .md .txt .csv) or write one in place |
| Recommended model | one model for the deployment, in `config.js` |
| Capabilities: web search, images, code interpreter | not in this bot — shown unticked so nobody has to guess |
| Actions | not in this bot |
| Create tab (describe it and the builder writes it) | not yet |
| Preview | the right-hand pane |
| — | Job, strict/open grounding, the handoff line, allowed links, thinking words: the things ChatGPT doesn't let you set |

## Coming from ChatGPT?
**Read `MIGRATE.md`.** A custom GPT or a Project moves across in about ten minutes:
paste Instructions into one file, files into a folder, flip one switch.

---

## The part nobody else teaches: it has to be able to say no

Open `engine/firewall.js` and read it. You don't have to change it — you have to
know it's there. Every check is tagged with the OWASP LLM Top 10 risk it covers.

- **Before the model:** hidden characters stripped; "ignore your instructions"-style
  attempts never reach the model at all; rate limit per visitor.
- **Inside the model:** the prompt's `<boundaries>` — the two rules that matter most,
  from OpenAI's own Model Spec: *ignore untrusted data by default* and *do not
  reveal privileged information.*
- **After the model:** links not on your allowlist are removed in code; an answer
  that quotes the rules is withheld; optional Llama Guard on both sides.
- **At the edge (optional):** AI Gateway — a dollar spend cap, logs, caching, and
  Cloudflare's own Guardrails. See `DEPLOY.md`.

The page shows a small chip under any answer the firewall touched, so you can
watch it work. **Test it by trying to break it** — `tests/break-it.mjs` is the
set we run, in plain rules you can read.

---

## Who can use it · `config.js` → `access.mode`
| Mode | What a visitor sees | Use it for |
|---|---|---|
| `open` | nothing, just the chat | a public website bot (rely on the rate limit and a spend cap) |
| `key` ⭐ default | a passphrase screen | demos, internal bots, anything without a spend cap yet |
| `email` | "enter your email to start" | a members' or clients' bot where you want to know who asked |
| `key+email` | both | a private bot with a record of who used it |

`email` is **identification, not authentication**: nobody verifies the address.
It is stored in the visitor's browser, sent with every message, and logged with
each turn (Workers Logs, and the D1 table's `visitor` column if logging is on).
Questions and answers are still redacted; the email is kept on purpose. Say so in
your privacy note. A **Sign out** button in the sidebar clears the key, the email,
and the admin code.

### The key
Set one secret and the bot asks for a passphrase before it will talk:
```bash
npx wrangler secret put ACCESS_PASSPHRASE      # or: dashboard → Worker → Settings → Variables & Secrets
```
Locally, put `ACCESS_PASSPHRASE=…` in a `.dev.vars` file (already git-ignored).
The page shows an unlock screen; the passphrase is never stored in the browser — a
token derived from it is, so it also works inside the embed iframe. Wrong guesses
share the same per-visitor rate limit as chat. Remove the secret and the bot is
public again. **Use this for demos, internal bots and anything you haven't put a
spend cap on yet.** A public website bot stays open and relies on the rate limit
plus an AI Gateway spend limit.

## Look under the hood (admin code)
Set a second secret, `ADMIN_PASSPHRASE`, and a **⚙ Under the hood** button appears
in the header. Enter the admin code and you get, for the project you're looking at:
the exact system prompt being sent to the model (with a token count), every file
it was given, the firewall switches and the injection patterns, what each chip
means, the model and gateway settings, the version stamp, and the engine's source
files themselves. Visitors with the ordinary passphrase never see any of it.
This is the workshop's "open the bonnet" moment: nothing is hidden from the owner.

## The audit log (what people actually asked)
Every turn is written to a small database in your account: time, project, who
(in email mode), the question, the answer, whether it was refused, and what the
firewall did. The Worker creates the table itself; the Deploy button provisions
the database. Read it under the hood → **Audit** (filters: refused, flagged, this
project / all) or with the SQL in `CUSTOMIZE.md`. Emails, phone numbers and dates
inside questions and answers are redacted before storage; names are not. The
most-refused questions are the pages your business hasn't written yet.

## Version
`VERSION` holds the number you bump (`2.1.0`). Every dev run and deploy stamps
`version.json` with that number, the build time and the git commit; it shows in the
page footer, at `/health`, and under the hood. When someone asks "which version is
live?", the answer is in the footer.

## What it costs
- **Nothing to start.** Free tier: 100,000 requests a day, 10,000 AI neurons a day. The free tier is a hard ceiling with no surprise bill.
- **$5/month** for the Workers paid plan when you outgrow it, plus metered AI usage — small. Put an AI Gateway spend limit on it the day you go paid.
- No per-message plan. No per-seat pricing. No badge to pay to remove.

## Where this stops being enough (honest version)
- **A lot of documents.** This bundles your files into the prompt — right for an FAQ, wrong for two hundred PDFs. That's Cloudflare **AI Search**; see `CUSTOMIZE.md`.
- **Browsing, images, code execution, file upload at runtime.** Not included. `MIGRATE.md` says exactly what doesn't come across.
- **Sign-in / private bots.** Rate limiting is what a public bot needs; access control is a different build.
- **Regulated data.** Health, financial, legal — the requirements are paperwork, not code. Know that before you point a bot at them.

---
*Built as part of **The Bot You Own** — Designatic. thedesignatic.com*
