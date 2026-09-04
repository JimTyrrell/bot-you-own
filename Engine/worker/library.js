// ============================================================================
//  THE LIBRARY — documents a bot can read (PDFs, Word, spreadsheets,
//  transcripts, screenshots)
//
//  knowledge/*.md is bundled straight into the prompt: right for a few pages
//  you want said word-for-word, wrong for a 60-page manual. The library is for
//  everything else. Files go into Cloudflare AI Search, which converts them
//  to text (a vision model reads images), chunks them, and hands the bot only
//  the passages relevant to each question. They land inside <files> in the
//  prompt, so strict/open grounding and every firewall rule apply unchanged.
//
//  One AI Search instance per deployment; every item is tagged with the bot
//  it belongs to, so Brightside never sees Ledgerly's files.
//
//  Two ways in, same place:
//    1. Configure → Documents (drag a file in; admin code required)
//    2. Drop files in YourBots/<bot>/knowledge/ in GitHub — an Action syncs
//       anything that isn't .md/.txt/.csv (those are bundled by the build)
//
//  Every file is SCANNED before it goes in (scanText below): emails, phone
//  numbers, card numbers, API keys, "CONFIDENTIAL", contract language, and a
//  second opinion from the model. Anything found = held back with the list.
//  You can override. The point is that nothing private goes in by accident.
//
//  Fail-open for readers: no binding, no instance, AI Search down — the bot
//  still answers from knowledge/. It never breaks because a PDF didn't index.
// ============================================================================

// What AI Search will actually convert and index. Anything else is refused
// BEFORE upload so it never sits in the library "indexed" with zero chunks.
// Source: developers.cloudflare.com/ai-search/configuration/data-source/
export const SUPPORTED = {
  // Converted by Cloudflare's Markdown Conversion (images: object detection + a vision model)
  rich: [".pdf", ".docx", ".odt", ".xlsx", ".xlsm", ".xlsb", ".xls", ".ods", ".numbers",
         ".html", ".htm", ".xml",
         ".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".bmp"],
  // Read as-is. (.md/.txt/.csv in knowledge/ are bundled into the prompt by the
  // build instead — the library is for the long ones you upload on purpose.)
  text: [".txt", ".md", ".markdown", ".csv", ".json", ".yaml", ".yml", ".rst", ".log",
         ".srt", ".vtt"],
};

// Cloudflare's limit. Bigger files are skipped by the indexer with an error.
export const MAX_BYTES = 4 * 1024 * 1024;

// Common things people WILL try that AI Search does not read.
const NOT_SUPPORTED_HINTS = {
  ".doc":   "Old Word format. Open it in Word or Google Docs and save as .docx.",
  ".pptx":  "Slides aren't supported. Export the deck to PDF and upload that.",
  ".ppt":   "Slides aren't supported. Export the deck to PDF and upload that.",
  ".key":   "Keynote isn't supported. Export to PDF and upload that.",
  ".pages": "Pages isn't supported. Export to PDF or .docx and upload that.",
  ".rtf":   "Save it as .docx or .txt first.",
  ".mp3":   "Audio isn't read. Upload the transcript as .txt instead.",
  ".mp4":   "Video isn't read. Upload the transcript as .txt instead.",
  ".m4a":   "Audio isn't read. Upload the transcript as .txt instead.",
  ".zip":   "Unzip it and upload the files inside one at a time.",
  ".heic":  "iPhone photo format. Save it as .jpg or .png first.",
};

// AI Search decides the type from the file NAME. Transcript exports get a
// name it understands; the content is unchanged.
const RENAME = { ".srt": ".txt", ".vtt": ".txt" };

export function extensionOf(name) {
  const m = String(name || "").toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

export function allExtensions() { return [...SUPPORTED.rich, ...SUPPORTED.text]; }

// What the Configure screen and the sync script need to explain themselves.
export function libraryMeta(env, config) {
  return { enabled: libraryEnabled(env, config), extensions: allExtensions(), maxBytes: MAX_BYTES, scan: config.library?.scan !== false };
}

// Returns { ok: true, name, ext } or { ok: false, reason }.
export function gate(name, size) {
  const ext = extensionOf(name);
  if (!ext) return { ok: false, reason: "The file needs an extension (like .pdf) so we know what it is." };
  if (size > MAX_BYTES) return { ok: false, reason: `That file is ${(size / 1048576).toFixed(1)} MB. The limit is 4 MB. Split it, compress it, or export a smaller version.` };
  if (size === 0) return { ok: false, reason: "That file is empty." };
  if (SUPPORTED.rich.includes(ext) || SUPPORTED.text.includes(ext)) {
    return { ok: true, name: safeName(name).replace(/\.[a-z0-9]+$/i, RENAME[ext] || ext), ext };
  }
  return { ok: false, reason: NOT_SUPPORTED_HINTS[ext] || `We don't read ${ext} files. Supported: ${allExtensions().join(" ")}` };
}

// The filename is what shows up as the source in the prompt. Readable but safe.
export function safeName(name) {
  return String(name).replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..")
    .map((p) => p.replace(/[^\w.\- ()]+/g, "_").trim()).join("/").slice(0, 160);
}

// ---------------------------------------------------------------------------
//  THE SCAN. Pattern-based: fast, free, explainable — you're told exactly what
//  was found. Runs on the converted TEXT, so PDFs, sheets and screenshots all
//  get the same treatment.
//
//  ⚠️ KNOWN GAP, same as the log redaction: this does NOT catch names, or
//  "the Henderson deal is falling apart." Nothing pattern-based does. The
//  model check below catches some of that. Neither replaces reading the file.
// ---------------------------------------------------------------------------
const CHECKS = [
  { id: "email",    label: "email addresses",             re: /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, max: 2 },
  { id: "phone",    label: "phone numbers",               re: /(?:^|[^\d])(\+?\d[\d\s().-]{8,}\d)(?=$|[^\d])/g, max: 2 },
  { id: "card",     label: "card numbers",                re: /\b(?:\d[ -]?){13,19}\b/g, max: 0, test: luhn },
  { id: "ssn",      label: "US social security numbers",  re: /\b\d{3}-\d{2}-\d{4}\b/g, max: 0 },
  { id: "iban",     label: "bank account numbers (IBAN)", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, max: 0 },
  { id: "secret",   label: "API keys or tokens",          re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/g, max: 0 },
  { id: "password", label: "passwords written down",      re: /\b(?:password|passwd|pwd|passcode)\s*[:=]\s*\S{4,}/gi, max: 0 },
  { id: "privkey",  label: "private keys",                re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, max: 0 },
  { id: "marking",  label: "confidentiality markings",    re: /\b(?:confidential|do not distribute|not for distribution|internal (?:use )?only|privileged|attorney[- ]client|under nda|non-disclosure)\b/gi, max: 0 },
  { id: "contract", label: "contract language",           re: /\b(?:this agreement is (?:made|entered)|hereinafter|the parties agree|indemnif(?:y|ication)|governing law|witness whereof)\b/gi, max: 1 },
  { id: "salary",   label: "salary or payroll data",      re: /\b(?:salary|payroll|gross pay|net pay|annual compensation)\b/gi, max: 1 },
];

function luhn(s) {
  const d = s.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}

// [] if clean, else [{ id, label, count, sample }]
export function scanText(text) {
  const t = String(text || "").slice(0, 400_000);
  const flags = [];
  for (const c of CHECKS) {
    const hits = [];
    for (const m of t.matchAll(c.re)) { const v = (m[1] ?? m[0]).trim(); if (c.test && !c.test(v)) continue; hits.push(v); }
    // A public FAQ legitimately has ONE email and ONE phone number in it — the
    // company's. Forty is a customer list. Hence `max`.
    const distinct = [...new Set(hits.map((h) => h.toLowerCase()))];
    if (distinct.length > c.max) flags.push({ id: c.id, label: c.label, count: distinct.length, sample: mask(distinct[0]) });
  }
  return flags;
}

function mask(s) { s = String(s); return s.length <= 6 ? s : s.slice(0, 3) + "…" + s.slice(-2); }

// Get the text out so we can scan it. Text types are decoded; everything else
// goes through Workers AI's converter — the same conversion AI Search does on
// its side, so what we scan is what the bot will see. (Also used by
// /api/attach: a visitor's file is read the same way, then thrown away.)
export async function extractText(env, name, ext, bytes) {
  if (SUPPORTED.text.includes(ext)) return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!env.AI?.toMarkdown) return "";
  try {
    // The converter wants a typed blob; the extension picks the parser.
    const r = await env.AI.toMarkdown({ name: name.split("/").pop(), blob: new Blob([bytes], { type: mimeFor(ext) }) });
    return typeof r?.data === "string" ? r.data : "";
  } catch (err) { console.error("toMarkdown failed for scan", err?.message || err); return ""; }
}
const MIME = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet", ".html": "text/html", ".htm": "text/html", ".xml": "application/xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp" };
const mimeFor = (ext) => MIME[ext] || "application/octet-stream";

// Second opinion from the model (config.library.scanWithModel). Catches what
// patterns can't: "this is clearly a client's invoice." One short call.
// Always Workers AI, even if the bot itself talks to OpenAI/Anthropic.
const SCAN_FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
async function modelOpinion(env, config, name, text) {
  if (!config.library?.scanWithModel || !text || !env.AI) return null;
  const model = config.provider === "workers-ai" && config.model ? config.model : SCAN_FALLBACK_MODEL;
  try {
    const result = await env.AI.run(model, {
      messages: [
        { role: "system", content: `You review documents before they are added to a PUBLIC customer-facing chatbot's knowledge. Anyone on the internet will be able to ask the bot about the contents.
Answer with exactly one line:
PUBLIC — if this is the kind of thing a business would put on its website (FAQ, product info, manual, policy, marketing, general how-to).
PRIVATE: <reason in under 15 words> — if it contains information about specific customers, employees, deals, finances, legal matters, credentials, or is marked confidential.
When unsure, say PUBLIC. Do not explain.` },
        { role: "user", content: `Filename: ${name}\n\n${text.slice(0, 6000)}` },
      ],
      // Reasoning models (gpt-oss) spend tokens thinking before the one line; leave room.
      max_tokens: 400,
    });
    const line = String(result?.response ?? result?.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim();
    const m = line.match(/PRIVATE\s*[:—-]\s*(.+)/i);
    return m ? m[1].trim().slice(0, 140) : null;
  } catch (err) { console.error("model scan failed (ignoring)", err?.message || err); return null; }
}

// ---------------------------------------------------------------------------
//  The instance. One per deployment, created on first upload. Nothing to click.
// ---------------------------------------------------------------------------
export function libraryEnabled(env, config) { return Boolean(env.AI_SEARCH && config.library?.name); }
const handle = (env, config) => env.AI_SEARCH.get(config.library.name);
const keyFor = (bot, name) => `${bot}/${name}`;

// The two metadata fields every item carries. AI Search only lets you filter
// on fields declared on the instance, so they're declared at create (and
// re-asserted on an existing instance once per isolate — idempotent).
// `approved` records that the scan was overridden, so Commit to GitHub can
// carry the approval into knowledge/APPROVED.txt and the sync action won't
// hold the same file back again.
const CUSTOM_METADATA = [{ field_name: "bot", data_type: "text" }, { field_name: "source", data_type: "text" }, { field_name: "approved", data_type: "text" }];
let ENSURED = false;
export async function ensureLibrary(env, config) {
  const id = config.library.name;
  if (ENSURED) return handle(env, config);
  let exists = false;
  try {
    const { result } = await env.AI_SEARCH.list({ search: id, per_page: 50 });
    exists = Array.isArray(result) && result.some((i) => i.id === id);
  } catch (err) { console.error("library list failed (will try create)", err?.message || err); }
  try {
    if (exists) await handle(env, config).update({ custom_metadata: CUSTOM_METADATA });
    else await env.AI_SEARCH.create({ id, custom_metadata: CUSTOM_METADATA });
    ENSURED = true;
  } catch (err) { console.error(`library ${exists ? "update" : "create"} returned`, err?.message || err); } // race, or already right — carry on
  return handle(env, config);
}

// ---------------------------------------------------------------------------
//  Retrieval — every chat turn. "" if there's nothing (or nothing works).
// ---------------------------------------------------------------------------
export async function retrieve(env, config, bot, question) {
  if (!libraryEnabled(env, config) || !bot) return "";
  const q = String(question || "").trim();
  if (!q) return "";
  try {
    const search = (withFilter) => handle(env, config).search({
      query: q,
      ai_search_options: {
        retrieval: {
          max_num_results: config.library.maxPassages ?? 6,
          match_threshold: config.library.matchThreshold ?? 0.4,
          context_expansion: 1,
          ...(withFilter ? { filters: { bot: { $eq: bot } } } : {}),
        },
        query_rewrite: { enabled: true },
      },
    });
    let r;
    try { r = await search(true); }
    catch (err) { if (!/undeclared metadata/i.test(String(err?.message || err))) throw err; r = await search(false); }
    // Belt and braces: the filter is the wall; the key prefix is the second wall.
    const chunks = (Array.isArray(r?.chunks) ? r.chunks : []).filter((c) => String(c.item?.key || "").startsWith(bot + "/"));
    if (!chunks.length) return "";
    return chunks.map((c) => `<excerpt from="${String(c.item?.key || "document").slice(bot.length + 1)}">\n${String(c.text || "").trim()}\n</excerpt>`).join("\n\n");
  } catch (err) {
    // No instance yet, still indexing, or AI Search hiccup. Bot still works.
    console.error("library search failed (continuing without it)", err?.message || err);
    return "";
  }
}

// ---------------------------------------------------------------------------
//  Upload / list / delete — admin only (see index.js). Returns one of:
//    { ok: true,  name, id, status, chunks }
//    { ok: false, name, reason }                              — refused outright
//    { ok: false, name, flagged: [...], needsOverride: true } — the scan found things
// ---------------------------------------------------------------------------
export async function uploadFile(env, config, bot, name, bytes, { override = false, source = "upload" } = {}) {
  const g = gate(name, bytes.byteLength);
  if (!g.ok) return { ok: false, name, reason: g.reason };

  if (config.library?.scan !== false && !override) {
    const text = await extractText(env, g.name, g.ext, bytes);
    const flagged = scanText(text);
    const opinion = await modelOpinion(env, config, g.name, text);
    if (opinion) flagged.push({ id: "model", label: "looks private", count: 1, sample: opinion });
    if (!text && !SUPPORTED.text.includes(g.ext)) flagged.push({ id: "unscanned", label: "couldn't read it to check", count: 1, sample: "Conversion failed, so the scan didn't run." });
    if (flagged.length) return { ok: false, name: g.name, flagged, needsOverride: true };
  }

  const lib = await ensureLibrary(env, config);
  try {
    // Upsert: same name replaces and re-indexes.
    // metadata.source tells the GitHub sync which items it owns ("github") and
    // which were dropped in by hand ("upload") — it only ever removes its own.
    const opts = { metadata: { bot, source: source === "github" ? "github" : "upload", approved: override ? "yes" : "no" }, waitMs: 5000 };
    const item = await uploadBytes(lib, keyFor(bot, g.name), bytes, g.ext, opts);
    if (item?.status === "error" || item?.status === "skipped") return { ok: false, name: g.name, reason: `Cloudflare couldn't read that file (status: ${item.status}${item.error ? ": " + String(item.error).slice(0, 120) : ""}). Try exporting it again, or as PDF.` };
    const indexed = item?.status === "completed" || (item?.chunks_count ?? 0) > 0;
    return { ok: true, name: g.name, id: item?.id, status: indexed ? "completed" : "indexing", chunks: item?.chunks_count ?? null };
  } catch (err) {
    const msg = String(err?.message || err);
    console.error("upload failed", msg);
    return { ok: false, name: g.name, reason: "Upload failed: " + msg.slice(0, 120) };
  }
}

// The binding's RPC is picky about what carries bytes (Blob and ArrayBuffer
// don't survive it in every runtime). Try the shapes in order; the first one
// the runtime accepts wins. Text types can always fall back to a string.
async function uploadBytes(lib, key, bytes, ext, opts) {
  const shapes = [
    ["stream", () => new Blob([bytes]).stream()],
    ["bytes", () => new Uint8Array(bytes)],
    ...(SUPPORTED.text.includes(ext) ? [["string", () => new TextDecoder().decode(bytes)]] : []),
  ];
  let last, item;
  for (const [label, make] of shapes) {
    try { item = await lib.items.upload(key, make(), { metadata: opts.metadata }); break; }
    catch (err) { last = err; if (!/serializ/i.test(String(err?.message || err))) throw err; console.warn(`upload as ${label} not accepted, trying the next shape`); }
  }
  if (!item) throw last;
  // Small files index in a few seconds; big PDFs take a minute. Wait a little
  // so the common case comes back "ready", then report whatever status it has.
  // (The binding's own uploadAndPoll waits the full timeout — too slow for a form.)
  // "completed" lags behind the chunks appearing, so chunks > 0 also counts as ready.
  const ready = (it) => ["completed", "error", "skipped"].includes(it?.status) || (it?.chunks_count ?? 0) > 0;
  const deadline = Date.now() + (opts.waitMs ?? 5000);
  while (Date.now() < deadline && !ready(item)) {
    await new Promise((r) => setTimeout(r, 1200));
    try { item = { ...item, ...(await lib.items.get(item.id).info()) }; } catch (err) { console.warn("poll failed (reporting last known status)", err?.message || err); break; }
  }
  return item;
}

export async function listFiles(env, config, bot) {
  if (!libraryEnabled(env, config)) return [];
  const lib = await ensureLibrary(env, config);
  const out = [];
  let page = 1;
  while (page <= 20) {
    // Key-name search, not the metadata filter: metadata only becomes
    // filterable once an item is indexed, and a file that's still queued
    // must still show up in the list. The startsWith below is the real gate.
    const { result, result_info } = await lib.items.list({ page, per_page: 50, search: bot + "/" });
    for (const it of result || []) {
      if (!String(it.key || "").startsWith(bot + "/")) continue;
      out.push({ id: it.id, name: String(it.key).slice(bot.length + 1), status: it.status, chunks: it.chunks_count ?? null, size: it.file_size ?? null, source: it.metadata?.source === "github" ? "github" : "upload", approved: it.metadata?.approved === "yes", updated: it.last_seen_at || it.created_at || null });
    }
    const total = result_info?.total_count ?? 0;
    if (!result || result.length < 50 || (total && page * 50 >= total)) break;
    page += 1;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The original bytes of one of this bot's documents — for Commit to GitHub,
// so the repo folder ends up holding the same files the library does.
export async function downloadFile(env, config, bot, id) {
  const lib = await ensureLibrary(env, config);
  const mine = await listFiles(env, config, bot);
  const f = mine.find((x) => x.id === id);
  if (!f) return null;
  const r = await lib.items.get(id).download();
  const body = r?.body ?? r;                       // { body, contentType, filename, size } or a bare stream
  const bytes = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
  return { ...f, bytes, contentType: r?.contentType || "" };
}

export async function deleteFile(env, config, bot, id) {
  const lib = await ensureLibrary(env, config);
  // Only this bot's items. A wrong id for another bot is a 404, not a deletion.
  const mine = await listFiles(env, config, bot);
  if (!mine.some((f) => f.id === id)) return false;
  await lib.items.delete(id);
  return true;
}
