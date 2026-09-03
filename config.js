// ============================================================================
//  THIS IS THE ONLY FILE MOST PEOPLE NEED TO CHANGE.
//  Edit it right here in GitHub (click the pencil icon), then click
//  "Commit changes". Your bot updates itself in about a minute.
//
//  Everything about WHAT the bot knows and HOW it behaves for one job lives in
//  projects/<name>/  (instructions.md + knowledge/ + project.json).
//  This file is the things that are true for ALL projects.
// ============================================================================

export const CONFIG = {
  // ---- 1. WHO OWNS THIS -----------------------------------------------------
  owner: "Example Co",                 // shown in the UI footer and in the prompt as "run by …"
  siteName: "The Bot You Own",         // browser tab title

  // ---- 2. WHICH PROJECT OPENS FIRST ------------------------------------------
  // Every folder in projects/ that is listed in projects/index.js is available in
  // the sidebar. This one is selected when someone opens the page.
  // Ship ONE project to customers. The samples exist so you can test the machine
  // before you feed it your own material — delete them from projects/index.js
  // when you go live (see projects/README.md).
  defaultProject: "example-co",

  // Hide the sidebar and show only the default project (for a customer-facing
  // deploy). The embed widget always behaves this way regardless.
  singleProject: false,

  // ---- 3. THE MODEL ----------------------------------------------------------
  // "workers-ai" needs NO API key — it's included with Cloudflare. Start here.
  // "openai" or "anthropic" need a secret (see DEPLOY.md) and go through AI Gateway.
  provider: "workers-ai",
  model: "@cf/openai/gpt-oss-120b",
  // model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",   // the previous default; passes the same set, pricier output
  // model: "gpt-4.1-mini",                    // provider: "openai"
  // model: "claude-opus-5",                   // provider: "anthropic"
  maxTokens: 900,

  // ---- 4. THE GATEWAY (optional, recommended the day you go paid) -------------
  // Create one in the Cloudflare dashboard: AI → AI Gateway → Create. Paste its
  // name here. You get logs, caching, a per-minute rate limit and a DOLLAR SPEND
  // CAP for free. Leave empty and the bot talks to the model directly.
  gateway: {
    id: "",                 // e.g. "my-bot-gateway"
    accountId: "",          // only needed for provider "openai" / "anthropic"
    cacheTtl: 0,            // seconds; 0 = don't cache answers
  },

  // ---- 5. THE FIREWALL ---------------------------------------------------------
  // All enforced in code (src/firewall.js). Each one fails OPEN: if it can't run,
  // the bot still answers. Read the file — you don't have to change it, you have
  // to know it's there.
  firewall: {
    blockInjections: true,   // "ignore your instructions…" never reaches the model
    stripLinks: true,        // only project.allowedLinks survive, enforced after the model answers
    blockPromptLeaks: true,  // an answer that quotes the rules is replaced with a refusal
    llamaGuard: false,       // extra Workers AI safety model on every turn (doubles cost). See CUSTOMIZE.md
    maxTurns: 12,            // how much history the model sees
    maxChars: 4000,          // per message
  },

  // ---- 6. LOOKS --------------------------------------------------------------
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
