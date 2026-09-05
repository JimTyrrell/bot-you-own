// ============================================================================
//  THIS IS THE ONLY FILE MOST PEOPLE NEED TO CHANGE.
//  Edit it right here in GitHub (click the pencil icon), then click
//  "Commit changes". Your bot updates itself in about a minute.
//
//  Everything about WHAT the bot knows and HOW it behaves for one job lives in
//  YourBots/<name>/  (instructions.md + knowledge/ + project.json).
//  This file is the things that are true for ALL projects.
// ============================================================================

export const CONFIG = {
  // ---- 1. WHO OWNS THIS -----------------------------------------------------
  owner: "Example Co",                 // shown in the UI footer and in the prompt as "run by …"
  siteName: "The Bot You Own",         // browser tab title

  // ---- 2. WHICH PROJECT OPENS FIRST ------------------------------------------
  // Every folder in YourBots/ that is listed in YourBots/index.js is available in
  // the sidebar. This one is selected when someone opens the page.
  // Ship ONE project to customers. The samples exist so you can test the machine
  // before you feed it your own material — delete them from YourBots/index.js
  // when you go live (see YourBots/README.md).
  defaultProject: "example-co",

  // Hide the sidebar and show only the default project (for a customer-facing
  // deploy). The embed widget always behaves this way regardless.
  singleProject: false,

  // ---- 3. THE MODEL ----------------------------------------------------------
  // "workers-ai" needs NO API key — it's included with Cloudflare. Start here.
  // "openai" or "anthropic" need a secret (see docs/DEPLOY.md) and go through AI Gateway.
  provider: "workers-ai",
  model: "@cf/openai/gpt-oss-120b",
  // model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",   // the previous default; passes the same set, pricier output
  // model: "gpt-4.1-mini",                    // provider: "openai"
  // model: "claude-opus-5",                   // provider: "anthropic"
  maxTokens: 900,

  // ---- 4. THE GATEWAY (on by default — the dollar ceiling) --------------------
  // Every model call goes through Cloudflare AI Gateway named below. You get
  // logs, caching, a per-minute rate limit and a DOLLAR SPEND LIMIT, all from the
  // dashboard, none of it in code. The gateway has to EXIST on your account
  // first: dashboard → AI → AI Gateway → Create Gateway, name it "bot-you-own"
  // (or the curl in docs/DEPLOY.md §D). Until it does, the bot notices, logs one
  // warning and talks to the model directly — a missing gateway never breaks a
  // chat. Under the hood → Gateway & model shows which way the last call went.
  gateway: {
    id: "bot-you-own",      // "" = talk to the model directly, no gateway
    accountId: "",          // only needed for provider "openai" / "anthropic"
    cacheTtl: 0,            // seconds; 0 = don't cache answers
  },

  // ---- 4a. CHEAP TURNS: "hi", "thanks", "ok" don't need a 120B model ----------
  // Engine/worker/router.js looks at the visitor's last message in plain code —
  // no model call — and if EVERY word is small talk (greeting, thanks, ok, bye,
  // an emoji) it answers with the small model below, same system prompt, 200
  // tokens. Anything with a question mark (strict bots), a number, an unknown
  // word or more than six words goes to the main model as always. When it
  // isn't sure, it's a real turn. Under the hood → Gateway & model shows the split.
  routing: {
    smallTurns: true,
    smallModel: "@cf/meta/llama-3.1-8b-instruct-fast",   // Workers AI catalogue: developers.cloudflare.com/workers-ai/models
    smallMaxTokens: 200,
  },

  // ---- 5. WHO CAN USE IT -----------------------------------------------------
  // "open"      — anyone with the link. For a public website bot.
  // "key"       — a shared passphrase (the ACCESS_PASSPHRASE secret). Demos, internal bots.
  // "email"     — visitors type an email address before chatting; it is logged with
  //               every turn. Identification, not authentication: nobody checks it.
  // "key+email" — both: the passphrase to get in, then an email so you know who asked.
  // If "key" is chosen but no ACCESS_PASSPHRASE secret exists, the bot falls back to
  // open and says so in the logs. The admin code (ADMIN_PASSPHRASE) is separate.
  access: { mode: "key" },

  // ---- 6. THE FIREWALL ---------------------------------------------------------
  // All enforced in code (Engine/worker/firewall.js). Each one fails OPEN: if it can't run,
  // the bot still answers. Read the file — you don't have to change it, you have
  // to know it's there.
  firewall: {
    blockInjections: true,   // "ignore your instructions…" never reaches the model
    stripLinks: true,        // only project.allowedLinks survive, enforced after the model answers
    blockPromptLeaks: true,  // an answer that quotes the rules is replaced with a refusal
    llamaGuard: false,       // extra Workers AI safety model on every turn (doubles cost). See docs/CUSTOMIZE.md
    maxTurns: 12,            // how much history the model sees
    maxChars: 4000,          // per message
  },

  // ---- 6a. THE LIBRARY: PDFs, Word docs, spreadsheets, transcripts, images ----
  // knowledge/*.md is bundled into the prompt — a few pages, word-for-word.
  // The library is for everything else: files go into Cloudflare AI Search and
  // the bot gets the relevant passages per question. Each bot only sees its own.
  // Two ways in: Configure → Documents, or drop files into YourBots/<bot>/knowledge/
  // and let the GitHub Action sync them. docs/CUSTOMIZE.md → "Give it documents".
  // Answers that used the library cite it: a 📄 chip per document under the reply
  // (names only — visitors never get the files).
  // A bot can also answer from its own WEBSITE: project.json → "website": { "url": … }.
  // Cloudflare crawls it into a second instance ("<name>-web-<bot>") and re-crawls
  // on the schedule below. Free plan: 500 pages a day. "Or point it at your website" in the docs.
  library: {
    name: "bot-you-own-library",   // the AI Search instance; created on first upload
    maxPassages: 6,                // excerpts per question, documents and web pages together. 4–8. More is not smarter.
    matchThreshold: 0.4,           // 0–1. Raise to 0.5 if it quotes unrelated documents.
    contextTurns: 2,               // earlier visitor messages added to the search, so "and on Thursdays?" finds the page. 0 = latest message only.
    scan: true,                    // scan every upload for emails, cards, keys, "CONFIDENTIAL"… before it goes in
    scanWithModel: true,           // …and ask the model "would a business put this on its website?" (one small call)
    crawlIntervalHours: 24,        // how often a bot's website is re-crawled. 1, 2, 4, 6, 12 or 24 (the values Cloudflare offers)
    crawlMaxPages: 200,            // pages per crawl. Keep it under the free plan's 500 a day; raise it on a paid plan
  },

  // ---- 6a'. VISITOR ATTACHMENTS: "here's my invoice, what does it say?" --------
  // The paperclip next to the send button. A visitor attaches ONE file (PDF,
  // Word, spreadsheet, text or an image) and the bot reads it for THAT
  // conversation only. Nothing is stored on the server: the text is read out,
  // checked, handed back to the visitor's browser and re-sent with each message
  // while the chat lasts — exactly like the chat history. It never goes into
  // the library and never becomes a fact about your business (strict grounding
  // still refuses anything about you that isn't in your own files).
  // Every attachment is screened: "ignore your instructions" inside a PDF is
  // refused, and so is anything that looks like a card number or a key.
  attachments: {
    enabled: true,               // false hides the paperclip and switches the route off
    max: 1,                      // files per conversation
    maxBytes: 4 * 1024 * 1024,   // 4 MB, Cloudflare's converter limit
    maxChars: 20000,             // the text is cut here (about 8 pages); the bot is told it was cut
  },

  // ---- 6a-i. VOICE IN AND OUT: talk to it, and hear it back --------------------
  // The microphone next to the paperclip, and a small speaker on every reply.
  // IN:  press the mic, talk, press again (or wait for maxSeconds). The browser's
  //      own recorder sends the clip to /api/transcribe; Workers AI (Whisper)
  //      turns it into text; the text lands in the input box for the visitor
  //      to check and send. Nothing goes to Google or Apple — it's your Worker.
  // OUT: the speaker under a reply reads it aloud (/api/speak → a Deepgram Aura
  //      voice on Workers AI). Auto-speak in the header reads every reply; off
  //      by default and remembered per browser.
  // Every clip and every read-out is a normal Workers AI call on your account,
  // through the same door and rate limit as the chat. Nothing is stored.
  // What it costs (developers.cloudflare.com/workers-ai/platform/pricing, Sept 2026):
  //   whisper-large-v3-turbo  $0.0005 per audio MINUTE  (46.63 neurons/min)
  //   aura-1                  $0.015 per 1,000 CHARACTERS spoken (1,363.64 neurons/1k)
  //   aura-2-en               $0.030 per 1,000 characters — the newer voice, twice the price
  //   10,000 neurons a day are free. A 30-second question is a quarter of a cent;
  //   a 400-character answer read aloud is six-tenths of a cent.
  // Model ids and voice names are on developers.cloudflare.com/workers-ai/models/.
  voice: {
    enabled: true,                                 // false hides the mic and the speakers and switches both routes off
    sttModel: "@cf/openai/whisper-large-v3-turbo", // speech → text. Also on the catalogue: @cf/openai/whisper (older, same shape)
    ttsModel: "@cf/deepgram/aura-1",               // text → speech. @cf/deepgram/aura-2-en for the newer voice
    ttsVoice: "asteria",                           // aura-1 voices: angus (default), asteria, arcas, orion, orpheus, athena, luna, zeus, perseus, helios, hera, stella
    maxSeconds: 60,                                // the mic stops itself here
    maxChars: 1500,                                // a reply longer than this is read up to here (about 90 seconds of speech)
  },

  // ---- 6a-ii. WHEN IT HANDS OFF, TELL SOMEONE ----------------------------------
  // Each bot chooses a webhook and/or an email in its project.json → "handoffActions"
  // (Configure → "When it hands off, tell someone"). Email needs the send_email
  // binding in wrangler.jsonc AND a "from" address on a domain you've onboarded to
  // Cloudflare Email Sending. Empty = emails are skipped (webhooks still work).
  // docs/CUSTOMIZE.md → "When it hands off, tell someone".
  handoffEmailFrom: "",            // e.g. "bot@yourdomain.com"

  // ---- 6a-iii. LEADS: who asked, and what they want ----------------------------
  // Needs email mode (access.mode "email" or "key+email") so visitors leave an
  // address. Under the hood → Leads lists every visitor with their turns and
  // refusals, and can write an AI brief per lead: what they asked, their
  // situation, what they care about, objections, the next step, a 0–100 score
  // with the reason. Stored in D1, refreshed on demand. No email is sent from
  // here — a lead is pushed to the bot's webhook (project.json → handoffActions
  // .webhook, or the one below) as event "lead-summary". docs/CUSTOMIZE.md → "Leads".
  leads: {
    autoAfterTurns: 4,             // summarise automatically at a visitor's 4th turn; 0 = only by hand
    notifyScore: 70,               // push to the webhook automatically when the score is at least this
    webhook: "",                   // fallback webhook for leads when the bot has none of its own
    maxTurns: 40,                  // how many of the visitor's most recent turns the summary reads
  },

  // ---- 6b. GITHUB (for "Commit to GitHub" on the Configure screen) --------------
  // The repo this bot deploys from. With the GITHUB_TOKEN secret set (a fine-grained
  // token with Contents: read & write on ONLY this repo), the Configure screen can
  // write a bot's folder straight into the repo. If the repo is connected to
  // Cloudflare Workers Builds, that commit redeploys the bot: the round trip.
  github: { repo: "JimTyrrell/bot-you-own", branch: "main" },

  // ---- 7. LOOKS --------------------------------------------------------------
  accent: "#10a37f",

  // What the page says while it waits for the first word of an answer (usually
  // one to three seconds). One is picked at random, then they rotate. Any number
  // of words; a project can bring its own list in project.json → "thinkingWords".
  thinkingWords: [
    "Thinking", "Pondering", "Mulling it over", "Checking the files", "Rummaging",
    "Cogitating", "Noodling", "Consulting the notes", "Brewing", "Percolating",
    "Weighing it up", "Reading that back", "Sifting", "Deliberating", "Ruminating",
    "Chewing on it", "Looking that up", "Marshalling the facts", "Considering", "Composing",
  ],
};
