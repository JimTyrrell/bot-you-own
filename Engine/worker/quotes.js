// ============================================================================
//  MOTIVATIONAL QUOTES — the line under the greeting when a chat starts.
//
//  One is picked at random from a pool each time the empty chat screen is
//  drawn. Two pools:
//    the shared list   YourBots/config.js → quotes.list, or the Settings screen
//    a person's own    Settings → Motivational quotes → "For one person": an
//                      email address with its own lines. When the visitor is
//                      that person (the email they gave at the gate), their
//                      list REPLACES the shared one. Kept in D1 only — never
//                      written into YourBots/settings.json, so no email address
//                      ever lands in the repo.
//
//  ${name} anywhere in a line becomes the visitor's FIRST name — the one the
//  sign-up gate collected (id_users.name). No name? Then:
//    quotes.fallback set   →  that word instead ("friend")
//    quotes.fallback empty →  the placeholder is dropped and the sentence tidied:
//                             "Keep going, ${name}."   → "Keep going."
//                             "${name}, start today."  → "Start today."
//                             "Welcome, ${name}, to…"  → "Welcome to…"
//  The same filler runs in the page for a bot's greeting (project.json →
//  greeting may carry ${name} too) — Engine/public/index.html → fillName().
//
//  Every line in the box is public domain: authors dead for more than seventy
//  years, or a translation old enough to be (Epictetus via George Long, 1877).
//  Nothing here needs crediting; the names are kept because a quote without
//  one reads like the bot's own opinion. Same merge as every other setting:
//  config.js < settings.json < the saved row (Engine/worker/settings.js).
// ============================================================================

// What ships when the owner's list is empty: two lines so a fresh deploy shows
// something. The full set lives in YourBots/config.js → quotes, the owner's file.
export const QUOTES_BUILT_IN = {
  show: true,
  fallback: "",
  list: [
    "“Well done is better than well said.” — Benjamin Franklin. Go do one thing well today, ${name}.",
    "“Do what you can, with what you have, where you are.” — Theodore Roosevelt. That is enough to start, ${name}.",
  ],
  people: {},
};

export const QUOTE_LIMITS = { lineChars: 400, lines: 200, people: 500, fallbackChars: 40, nameChars: 40 };

const PLACEHOLDER = /\$\{\s*name\s*\}/gi;

// The visitor's first name, trimmed to something that fits in a sentence.
export function firstNameOf(name) {
  return String(name || "").trim().split(/\s+/)[0].slice(0, QUOTE_LIMITS.nameChars);
}

// ${name} → the name; or the fallback; or nothing, with the sentence tidied.
export function fillQuote(text, name = "", fallback = "") {
  let t = String(text || "");
  if (!PLACEHOLDER.test(t)) return t;
  PLACEHOLDER.lastIndex = 0;
  const first = firstNameOf(name), fb = String(fallback || "").trim().slice(0, QUOTE_LIMITS.fallbackChars);
  if (first) return t.replace(PLACEHOLDER, first);
  // The fallback is a word, not a name: it takes a capital when it opens a sentence ("Friend, start today.").
  if (fb) return t.replace(PLACEHOLDER, (m, at) => (at === 0 || /[.!?]\s+$/.test(t.slice(0, at)) ? fb[0].toUpperCase() + fb.slice(1) : fb));
  // No name, no fallback: take the placeholder out and leave a sentence behind.
  t = t.replace(/,\s*\$\{\s*name\s*\}\s*,\s*/gi, " ");                                         // "Welcome, ${name}, to" → "Welcome to"
  t = t.replace(/(^|[.!?]\s+)\$\{\s*name\s*\}\s*[,:;!]?\s*(\S)/gi, (m, pre, ch) => pre + ch.toUpperCase());   // "${name}, start" → "Start"
  t = t.replace(/\s*[,;:]?\s*\$\{\s*name\s*\}(?=\s*[.!?,;:]|\s*$)/gi, "");                     // "going, ${name}." → "going."
  t = t.replace(/\s*\$\{\s*name\s*\}\s*/gi, " ");                                              // anything left, mid-sentence
  return t.replace(/\s+([.!?,;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

const cleanLines = (arr) => (Array.isArray(arr) ? arr : []).map((s) => String(s ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).map((s) => s.slice(0, QUOTE_LIMITS.lineChars)).slice(0, QUOTE_LIMITS.lines);
const cleanEmail = (e) => { const v = String(e || "").trim().toLowerCase().slice(0, 254); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : ""; };

// Clean one layer. Returns null for "nothing here"; otherwise every field, with
// `base` filling what the layer left out. An empty list means "keep the one
// below" — untick `show` to turn quotes off. `people` is replaced whole when
// given (the Settings screen sends the full map); a person with no lines is dropped.
export function cleanQuotes(q, base = QUOTES_BUILT_IN) {
  if (!q || typeof q !== "object") return null;
  const list = cleanLines(q.list);
  let people = base.people || {};
  if (q.people && typeof q.people === "object" && !Array.isArray(q.people)) {
    people = {};
    for (const [k, v] of Object.entries(q.people)) {
      const email = cleanEmail(k); if (!email) continue;
      const lines = cleanLines(v); if (!lines.length) continue;
      people[email] = lines;
      if (Object.keys(people).length >= QUOTE_LIMITS.people) break;
    }
  }
  return {
    show: q.show === undefined ? base.show !== false : q.show !== false,
    fallback: String(q.fallback ?? base.fallback ?? "").trim().slice(0, QUOTE_LIMITS.fallbackChars),
    list: list.length ? list : base.list || [],
    people,
  };
}

export function mergeQuotes(c, f, s) {
  let cur = QUOTES_BUILT_IN, source = "built-in";
  for (const [layer, label] of [[c, "YourBots/config.js"], [f, "YourBots/settings.json"], [s, "saved (Settings screen)"]]) { const v = cleanQuotes(layer, cur); if (v) { cur = v; source = label; } }
  return { ...cur, source };
}

// The pick. `email` is who the visitor is (the gate's address, "" for nobody);
// their own list wins when they have one. Returns null when there is nothing
// to show. `rnd` is injectable so the test can pin the choice.
export function pickQuote(q, { email = "", name = "" } = {}, rnd = Math.random) {
  if (!q || q.show === false) return null;
  const own = email ? q.people?.[cleanEmail(email)] : null;
  const pool = Array.isArray(own) && own.length ? own : Array.isArray(q.list) ? q.list : [];
  if (!pool.length) return null;
  const text = pool[Math.min(pool.length - 1, Math.max(0, Math.floor(rnd() * pool.length)))];
  return { text, filled: fillQuote(text, name, q.fallback), fallback: q.fallback || "", own: Boolean(own && own.length) };
}

// What the Settings screen writes into the file half of the merge: the shared
// list and the switches. Never the people — their addresses stay in the database.
export function quotesFileView(q) {
  const v = q || QUOTES_BUILT_IN;
  return { show: v.show !== false, fallback: v.fallback || "", list: Array.isArray(v.list) ? v.list : [] };
}
