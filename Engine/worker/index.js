import { CONFIG } from "../../YourBots/config.js";
import { PROJECTS, getProject as folderProject, listProjects as folderList } from "../../YourBots/index.js";
import { buildSystemPrompt, PROMPT_FILES, ROOT_PROMPT_FILES } from "./prompt.js";
import { complete } from "./gateway.js";
import { screenInbound, screenOutbound, ensureHandoff, stripHandoffMarker, llamaGuard, redact, INJECTION_PATTERNS, SECRET_PATTERNS, LLAMA_GUARD_MODEL } from "./firewall.js";
import { detectLanguage, chooseLanguage, languageSettings } from "./language.js";
import { MODES } from "./modes.js";
import { retrieve, uploadFile, listFiles, deleteFile, downloadFile, rescanLibrary, extractText, libraryMeta, allExtensions, gate, safeName, scanText, websiteOf, crawlWebsite, websiteStatus, deleteWebsite } from "./library.js";
import { normaliseHandoffActions, stripIntakeMarker, handoffEvent, runHandoffActions, handoffActionsView } from "./handoff.js";
import { listLeads, getLead, summariseLead, sendLead, maybeAutoLead, leadsConfig, cleanVisitor } from "./leads.js";

// ============================================================================
//  THE WORKER. Four routes and a static folder.
//    GET  /api/config   → what the page needs to draw itself
//    POST /api/chat     → { project, messages, stream, attachments } → SSE stream (or JSON)
//    POST /api/attach   → multipart "file" → { ok, name, chars, text } (the paperclip;
//                         nothing is stored — the text goes back to the visitor's browser)
//    GET  /health       → "ok"
//    *                  → public/ (the chat page, the widget)
//  Admin (x-admin-token): /api/admin/engine, /audit, /projects, /project,
//    /api/admin/library?project=<id>  GET list · POST upload (multipart "file",
//    optional "override") · DELETE /api/admin/library/<itemId>?project=<id>
//    POST /api/admin/library/rescan?project=<id>   re-check every document (read-only)
//    GET  /api/admin/library/audit?project=<id|*>  what the scan did, newest first
//    /api/admin/library/crawl?project=<id>  GET status of the bot's website
//    crawl · POST crawl it now (creates the crawler instance the first time) ·
//    DELETE remove the crawler instance and its pages
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") { const v = await versionStamp(env); return new Response(`ok ${v.version} ${v.commit} ${v.builtAt}`.trim()); }

    // --- THE DOOR. If the ACCESS_PASSPHRASE secret is set, the bot is locked:
    //     /api/config hides the projects and /api/chat refuses without a token.
    //     Unset = a public bot. See docs/DEPLOY.md → "Lock it".
    // --- WHO CAN USE IT (config.access.mode): open | key | email | key+email ---
    const wantKey = /key/.test(CONFIG.access?.mode || "key");
    const wantEmail = /email/.test(CONFIG.access?.mode || "");
    if (wantKey && !env.ACCESS_PASSPHRASE) console.warn("access.mode wants a key but ACCESS_PASSPHRASE is not set — running open");
    const locked = wantKey && Boolean(env.ACCESS_PASSPHRASE);
    const token = locked ? await accessToken(env) : null;

    // --- THE ADMIN CODE. A second secret, ADMIN_PASSPHRASE, opens "Under the
    //     hood": the exact prompt, the files, the firewall rules, the source.
    //     Visitors never see it. An admin token also counts as a visitor token.
    const adminEnabled = Boolean(env.ADMIN_PASSPHRASE);
    const adminToken = adminEnabled ? await accessToken({ ACCESS_PASSPHRASE: env.ADMIN_PASSPHRASE }, "bot-you-own/admin/v1") : null;
    const isAdmin = adminEnabled && safeEqual(request.headers.get("x-admin-token") || "", adminToken);
    const authed = !locked || isAdmin || safeEqual(request.headers.get("x-access-token") || "", token);

    if (url.pathname === "/api/admin/unlock") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!adminEnabled) return json({ error: "no admin code is set" }, 404);
      if (!(await allowed(env, request))) return json({ error: "too many attempts" }, 429);
      let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
      const given = await accessToken({ ACCESS_PASSPHRASE: String(b.passphrase || "") }, "bot-you-own/admin/v1");
      return safeEqual(given, adminToken) ? json({ token: adminToken }) : json({ error: "wrong admin code" }, 401);
    }

    if (url.pathname.startsWith("/api/admin/") || url.pathname.startsWith("/engine/")) {
      if (!isAdmin) return json({ error: "admin only" }, adminEnabled ? 401 : 404);
      if (url.pathname === "/api/admin/engine") return json(await engineView(env, url.searchParams.get("project")));
      if (url.pathname === "/api/admin/audit") return json(await auditView(env, url.searchParams));
      if (url.pathname === "/api/admin/library" || url.pathname.startsWith("/api/admin/library/")) return handleLibrary(request, env, url);
      if (url.pathname === "/api/admin/leads" || url.pathname.startsWith("/api/admin/leads/")) return handleLeads(request, env, url);
      if (url.pathname === "/api/admin/projects") return json({ projects: await resolveList(env), jobs: Object.values(MODES).map((m) => ({ id: m.id, blurb: m.blurb, role: m.role, shape: m.shape, done: m.done })), model: CONFIG.model, canSave: Boolean(env.DB), rootPrompt: ROOT_PROMPT_FILES, github: { repo: CONFIG.github?.repo || "", branch: CONFIG.github?.branch || "main", ready: Boolean(CONFIG.github?.repo && env.GITHUB_TOKEN) }, library: libraryMeta(env, CONFIG) });
      if (url.pathname === "/api/admin/project") {
        const id = String(url.searchParams.get("id") || "").toLowerCase();
        if (request.method === "GET") { const p = await resolveProject(env, id); return json({ project: { ...p, id: p.id || id }, source: (await savedProjects(env))[id] ? "saved" : (PROJECTS[id] ? "folder" : "new") }); }
        if (!env.DB) return json({ error: "Saving needs the D1 database (wrangler.jsonc → d1_databases). Export the files instead." }, 400);
        if (request.method === "PUT") {
          let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
          const pid = String(b.id || id || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
          if (!pid) return json({ error: "give the bot a name" }, 400);
          const p = normaliseProject(b, pid);
          await ensureSchema(env);
          await env.DB.prepare(`INSERT INTO projects (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).bind(pid, JSON.stringify(p), new Date().toISOString()).run();
          SAVED_CACHE.at = 0;
          return json({ ok: true, id: pid, project: p });
        }
        if (request.method === "DELETE") { await ensureSchema(env); await env.DB.prepare(`DELETE FROM projects WHERE id = ?`).bind(id).run(); SAVED_CACHE.at = 0; return json({ ok: true, fallsBackToFolder: Boolean(PROJECTS[id]) }); }
        return json({ error: "method" }, 405);
      }
      if (url.pathname === "/api/admin/project/sync") {
        if (request.method !== "POST") return json({ error: "POST only" }, 405);
        return json(await syncToGitHub(env, String(url.searchParams.get("id") || "")));
      }
      if (url.pathname === "/api/admin/project/export") {
        const id = String(url.searchParams.get("id") || "");
        return json({ files: exportFiles(await resolveProject(env, id), id) });
      }
      if (url.pathname === "/api/admin/source") {
        const name = String(url.searchParams.get("name") || "");
        const res = await env.ASSETS.fetch(new Request(`${url.origin}/engine/${name.replace(/\//g, "__")}.txt`));
        return new Response(await res.text(), { status: res.status, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/unlock") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!locked) return json({ token: null, locked: false });
      if (!(await allowed(env, request))) return json({ error: "too many attempts" }, 429);
      let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
      const given = await accessToken({ ACCESS_PASSPHRASE: String(b.passphrase || "") });
      return safeEqual(given, token) ? json({ token, locked: true }) : json({ error: "wrong passphrase" }, 401);
    }

    if (url.pathname === "/api/config") {
      if (locked && !authed) return json({ locked: true, accessMode: accessMode(locked, wantEmail), siteName: CONFIG.siteName, accent: CONFIG.accent });
      const all = await resolveList(env);
      const projects = CONFIG.singleProject ? all.filter((p) => p.id === CONFIG.defaultProject) : all;
      return json({
        version: await versionStamp(env),
        locked,
        accessMode: accessMode(locked, wantEmail),
        adminEnabled,
        owner: CONFIG.owner,
        siteName: CONFIG.siteName,
        accent: CONFIG.accent,
        thinkingWords: Array.isArray(CONFIG.thinkingWords) ? CONFIG.thinkingWords : ["Thinking"],
        model: CONFIG.model,
        provider: CONFIG.provider,
        defaultProject: CONFIG.defaultProject,
        projects: projects.length ? projects : all.slice(0, 1),
        // the paperclip: whether to show it, and what it accepts
        attachments: { enabled: attachmentRules().enabled, max: attachmentRules().max, maxBytes: attachmentRules().maxBytes, extensions: allExtensions() },
      });
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!authed) return json({ error: "locked", reply: "This bot is locked. Enter the passphrase to continue." }, 401);
      return handleChat(request, env, ctx, { wantEmail, isAdmin });
    }

    // The paperclip. Same door as /api/chat; switched off = it doesn't exist.
    if (url.pathname === "/api/attach") {
      if (!attachmentRules().enabled) return json({ error: "not found" }, 404);
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!authed) return json({ error: "locked", reply: "This bot is locked. Enter the passphrase to continue." }, 401);
      return handleAttach(request, env, ctx);
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
};

// --- LLM10 Unbounded Consumption: rate limit per visitor (fail-open) -------
async function allowed(env, request) {
  if (!env.RATE_LIMITER) return true;
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    return success;
  } catch (err) {
    console.error("rate limit check failed, allowing through", err);
    return true;
  }
}

// --- The door: a token derived from the passphrase, never the passphrase itself.
//     The page stores the token in localStorage and sends it as a header, which
//     also works inside the embed iframe (cookies don't — see docs/CUSTOMIZE.md).
async function accessToken(env, label = "bot-you-own/access/v1") {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.ACCESS_PASSPHRASE || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function accessMode(locked, wantEmail) {
  return (locked ? "key" : "open") + (wantEmail ? "+email" : "");
}

const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

async function handleChat(request, env, ctx, { wantEmail = false, isAdmin = false } = {}) {
  if (!(await allowed(env, request))) {
    return json({ reply: "You're sending messages faster than I can think. Give me a moment and try again.", flags: ["rate-limited"] }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }

  // --- email mode: who is asking. Logged with every turn; never verified. ------
  const visitor = String(body.visitor?.email || "").trim().toLowerCase().slice(0, 254);
  if (wantEmail && !isAdmin && !EMAIL_SHAPE.test(visitor)) {
    return json({ error: "email", reply: "Please enter your email address to start." }, 401);
  }
  const who = visitor || (isAdmin ? "admin" : "");

  const project = (isAdmin && body.draft && typeof body.draft === "object")
    ? normaliseProject(body.draft, String(body.draft.id || "draft"))            // Configure → Preview: unsaved draft
    : await resolveProject(env, String(body.project || ""));
  const stream = body.stream !== false;
  const fw = CONFIG.firewall || {};

  // --- Trim history: last N turns, capped per message ----------------------
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-(fw.maxTurns || 12))
    .map((m) => ({ role: m.role, content: m.content.slice(0, fw.maxChars || 4000) }));
  if (!history.length || history[history.length - 1].role !== "user") {
    return json({ error: "last message must be from the user" }, 400);
  }

  const handoff = [project.handoffText, project.handoffContact].filter(Boolean).join(" ")
    || "I can't help with that one.";
  const send = (reply, flags) => stream ? sseOnce(reply, flags) : json({ reply, flags });

  // --- LLM01 / LLM07: the inbound screen. Never reaches the model. ----------
  const last = history[history.length - 1];
  const screen = screenInbound(last.content);
  last.content = screen.text;
  const flags = [];
  if (screen.invisible) flags.push("invisible-text-stripped");
  if (screen.secret) flags.push("secret-detected");
  if (screen.injection && fw.blockInjections !== false) {
    flags.push("injection-blocked");
    const reply = `I'm here to help with ${project.name}, so I'll skip that one. What can I help you with?`;
    ctx.waitUntil(afterReply(env, { project, question: last.content, reply, flags, who, history, url: request.url }));
    return send(reply, flags);
  }

  // --- Optional: Llama Guard on the user's turn ------------------------------
  if (fw.llamaGuard) {
    const g = await llamaGuard(env, [{ role: "user", content: last.content }]);
    if (g.ran && !g.safe) {
      flags.push("guard-blocked:" + (g.categories.join(",") || "unspecified"));
      const reply = "I can't help with that. If you're in a difficult situation, please reach out to someone qualified to help.";
      ctx.waitUntil(afterReply(env, { project, question: last.content, reply, flags, who, history, url: request.url }));
      return send(reply, flags);
    }
  }

  // --- The visitor's attachment(s). The page got the text from /api/attach and
  //     sends it back with every turn, like the history. The checks run AGAIN
  //     here — /api/chat is where it matters, and nothing stops a script from
  //     skipping /api/attach. Never logged; never stored.
  const attachments = [];
  const rules = attachmentRules();
  if (rules.enabled && Array.isArray(body.attachments)) {
    for (const a of body.attachments.slice(0, rules.max)) {
      if (!a || typeof a.text !== "string" || !a.text.trim()) continue;
      const v = vetAttachment(a.text, rules.maxChars);
      if (v.refused) {
        flags.push(v.flag);
        ctx.waitUntil(logTurn(env, project, last.content, v.reason, flags, who));
        return send(v.reason, flags);
      }
      attachments.push({ name: safeName(a.name || "attachment").slice(0, 120) || "attachment", text: v.text });
    }
  }
  if (attachments.length) flags.push("attachment-used");

  // --- LAYER 2b: the library, and the website if the bot has one. Relevant
  //     excerpts from this bot's documents (PDFs, sheets, transcripts) and its
  //     crawled pages for THIS question. The search is given the visitor's last
  //     few messages, not just the latest one, so a follow-up like "and on
  //     Thursdays?" still finds the right page. "" if none, or if AI Search
  //     isn't set up — the bot answers from knowledge/ regardless.
  //     `sources` = the document names / page URLs, shown under the answer.
  const userTurns = history.filter((m) => m.role === "user").map((m) => m.content);
  const found = await retrieve(env, CONFIG, project.id || CONFIG.defaultProject, userTurns, { website: websiteOf(project) });
  const passages = found.text;
  const sources = found.sources;
  if (found.library) flags.push("library-used");
  if (found.website) flags.push("website-used");

  // --- LAYER 1a: which language to answer in. A cheap guess from the visitor's
  //     last two messages — script and stopwords, no model call (Engine/worker/
  //     language.js). Unsure = English, exactly as before. The flag records what
  //     the visitor wrote in; config.languages decides what the bot replies in.
  const language = chooseLanguage(languageSettings(CONFIG), detectLanguage(userTurns.slice(-2)));
  if (language.detected) flags.push("language:" + language.detected);
  if (language.unavailable) flags.push("language-unavailable");

  // --- LAYER 1: build the prompt --------------------------------------------
  const prompt = buildSystemPrompt({ config: CONFIG, project, passages, attachments, language });
  const outboundOpts = { allowedLinks: project.allowedLinks, protectedText: prompt.protectedText, config: CONFIG, project };
  // A second, non-streaming call with the same prompt — used only if the first reply came out as garbage (see finish()).
  const retry = () => complete({ env, config: CONFIG, system: prompt.text, messages: history, stream: false });

  // --- LAYER 3b: call the model through the gateway --------------------------
  let result;
  try {
    result = await complete({ env, config: CONFIG, system: prompt.text, messages: history, stream });
  } catch (err) {
    console.error("model call failed", err?.code || "", err?.message || err);
    const f = [...flags, err?.code === "gateway-blocked" ? "gateway-blocked" : err?.code === "rate-limited" ? "provider-rate-limited" : "model-error"];
    ctx.waitUntil(afterReply(env, { project, question: last.content, reply: handoff, flags: f, who, history, url: request.url }));
    return send(handoff, f);
  }

  // --- Non-streaming path -----------------------------------------------------
  if (!stream) {
    const out = await finish(String(result), { env, fw, flags, handoff, outboundOpts, retry });
    ctx.waitUntil(afterReply(env, { project, question: last.content, reply: out.reply, flags: out.flags, who, history, url: request.url }));
    return json({ reply: out.reply, flags: out.flags, sources });
  }

  // --- Streaming path: send deltas as they come, then a "final" event with the
  //     firewall-checked text. The page replaces what it showed with "final".
  //     (Links and leaks can span chunks, so the check runs on the whole reply.)
  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    async start(controller) {
      const push = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let full = "";
      try {
        for await (const chunk of result) {
          full += chunk;
          push({ type: "delta", text: chunk });
        }
        const out = await finish(full, { env, fw, flags, handoff, outboundOpts, retry });
        push({ type: "final", text: out.reply, flags: out.flags, sources });
        ctx.waitUntil(afterReply(env, { project, question: last.content, reply: out.reply, flags: out.flags, who, history, url: request.url }));
      } catch (err) {
        console.error("stream failed", err);
        push({ type: "final", text: handoff, flags: [...flags, "stream-error"] });
      }
      controller.close();
    },
  });
  return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}

// LAYER 3a outbound: links, leaks, optional Llama Guard on the answer.
async function finish(raw, { env, fw, flags, handoff, outboundOpts, retry = null }) {
  const out = screenOutbound(raw.trim(), outboundOpts);
  let reply = out.text;
  const f = [...flags, ...out.flags];
  // Models occasionally come apart and emit "!!!!!!!!" or "Quick Quick Quick…"
  // for a whole reply (seen three times in one evening's test runs, always
  // gpt-oss). A visitor should never see that. Enforced in code: a reply that
  // is mostly one repeated character or one repeated word becomes the handoff.
  if (reply && isDegenerate(reply)) {
    // One more go, non-streaming, before giving up on the answer. Costs one
    // extra model call about once in thirty turns; saves a good answer most times.
    let again = "";
    try { again = retry ? String(await retry()).trim() : ""; } catch (err) { console.error("retry after degenerate reply failed", err?.message || err); }
    if (again && !isDegenerate(again)) { f.push("degenerate-retried"); reply = screenOutbound(again, outboundOpts).text; }
    else { f.push("degenerate-reply"); reply = ""; }
  }
  if (reply) {
    // A strict bot ends a decline with "[HANDOFF]" (YourBots/_prompt/7-answering-strict.md)
    // so the code can tell a decline in any language. Take the line out, then make
    // sure the owner's contact is there — appended, verbatim, if the model dropped it.
    const hm = stripHandoffMarker(reply);
    if (hm.found) reply = hm.text;
    const h = ensureHandoff(reply, outboundOpts.project, { declined: hm.found });
    if (h.added) { reply = h.text; f.push("handoff-appended"); }
    // An intake bot ends its final summary with "[INTAKE COMPLETE]" (YourBots/_prompt/jobs/intake.md).
    // Take the line out — the visitor and the audit log never see it — and remember it fired.
    // (On the streaming path the line may flash for a moment before "final" replaces the text.)
    const m = stripIntakeMarker(reply);
    if (m.found) { reply = m.text; if (m.done && outboundOpts.project.mode === "intake") f.push("intake-complete"); }
  }
  if (reply && fw.llamaGuard) {
    const g = await llamaGuard(env, [{ role: "user", content: "(user message)" }, { role: "assistant", content: reply }]);
    if (g.ran && !g.safe) { f.push("guard-blocked-output:" + g.categories.join(",")); reply = ""; }
  }
  if (!reply) reply = handoff;
  return { reply, flags: f };
}

// --- THE PAPERCLIP: a visitor attaches one file to the conversation. ----------
//     Read it → cut it to size → screen it → hand the TEXT back to the browser.
//     Nothing is stored here: not the file, not the text. The page keeps the
//     text with the chat and sends it back with every message (index.html).
//     The scan is the library's (Engine/worker/library.js), but the verdicts
//     are different: a card number or a key is refused outright (a visitor
//     can't override), while their own email address or phone number is fine.
function attachmentRules() {
  const a = CONFIG.attachments || {};
  return { enabled: a.enabled !== false, max: Math.max(1, Number(a.max) || 1), maxBytes: Number(a.maxBytes) || 4 * 1024 * 1024, maxChars: Number(a.maxChars) || 20000 };
}
// The blocking half of the scan. Emails/phones/"confidential" are the
// visitor's business; these are the things that should never be in a chat.
const ATTACH_BLOCKS = ["card", "ssn", "iban", "secret", "password", "privkey"];
function vetAttachment(text, maxChars) {
  let t = String(text || "");
  const notes = [];
  if (t.length > maxChars) { t = t.slice(0, maxChars) + "\n[truncated]"; notes.push(`Only the first ${maxChars.toLocaleString("en-US")} characters are used; the rest was cut.`); }
  const screen = screenInbound(t);                  // strips invisible characters, looks for "ignore your instructions…"
  t = screen.text;
  if (screen.invisible) notes.push("Hidden characters were removed.");
  if (screen.injection) return { refused: true, flag: "attachment-injection-blocked", reason: "That file contains text that reads like instructions for me (\"ignore your previous instructions…\"), so I can't take it. If it's your own document, remove that part and try again." };
  const found = scanText(t).filter((f) => ATTACH_BLOCKS.includes(f.id));
  if (found.length) return { refused: true, flag: "attachment-secret-blocked", reason: `That file looks like it contains ${found.map((f) => f.label).join(" and ")} — remove it and try again. I don't take card numbers, keys or ID numbers in chat.` };
  return { text: t, notes };
}
async function handleAttach(request, env, ctx) {
  if (!(await allowed(env, request))) return json({ ok: false, reason: "You're sending files faster than I can read them. Give me a moment and try again.", flags: ["rate-limited"] }, 429);
  const rules = attachmentRules();
  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, reason: "Send the file as multipart/form-data in a 'file' field." }, 400); }
  const f = form.get("file");
  if (!f || typeof f.arrayBuffer !== "function") return json({ ok: false, reason: "No file in the request." }, 400);
  const project = await resolveProject(env, String(form.get("project") || ""));
  const log = (chars, flags) => console.log(JSON.stringify({ event: "attach", project: project.name, name: safeName(f.name).slice(0, 120), chars, flags }));

  // 1. Type and size — the library's gate, with its plain-English hints (".pptx → export as PDF").
  const g = gate(f.name, f.size);
  if (!g.ok) { log(0, ["attachment-refused"]); return json({ ok: false, name: safeName(f.name), reason: g.reason, flags: ["attachment-refused"] }, 400); }
  if (f.size > rules.maxBytes) { log(0, ["attachment-refused"]); return json({ ok: false, name: g.name, reason: `That file is ${(f.size / 1048576).toFixed(1)} MB. The limit is ${Math.round(rules.maxBytes / 1048576)} MB.`, flags: ["attachment-refused"] }, 400); }

  // 2. Read it. Text files are decoded; PDFs, Word, sheets and images go
  //    through Cloudflare's converter (an image comes back as a description).
  const isImage = /\.(jpe?g|png|webp|gif|svg|bmp)$/.test(g.ext);
  let text = "";
  try { text = await extractText(env, g.name, g.ext, await f.arrayBuffer()); } catch (err) { console.error("attach: extract failed", err?.message || err); }
  if (!String(text || "").trim()) { log(0, ["attachment-refused"]); return json({ ok: false, name: g.name, reason: isImage ? "I couldn't make out anything in that image. Try a clearer picture, or a PDF." : "I couldn't read any text in that file. If it's a scan, try a clearer copy; if it's a document, try exporting it as PDF.", flags: ["attachment-refused"] }, 400); }

  // 3. Cut, then screen: injections and secrets are refused, with the reason.
  const v = vetAttachment(text, rules.maxChars);
  if (v.refused) { log(text.length, [v.flag]); return json({ ok: false, name: g.name, reason: v.reason, flags: [v.flag] }, 400); }
  const notes = [...v.notes];
  if (isImage) notes.push("Images come back as a description from Cloudflare's converter — what it noticed, not the pixels.");
  log(v.text.length, []);
  return json({ ok: true, name: g.name, chars: v.text.length, text: v.text, notes });
}

// --- After the reply has gone out: tell someone (if configured), then log. ----
// Runs inside ctx.waitUntil, so the visitor never waits for any of it. The
// action runs FIRST and the audit row is written afterwards — on purpose: that
// way the row records what actually happened (handoff-webhook-sent / -failed,
// handoff-email-skipped) instead of a guess, and the only cost is that the row
// lands up to five seconds later. The reply already went out, so the chips on
// the visitor's screen don't show these flags; the Audit tab does.
async function afterReply(env, { project, question, reply, flags, who, history, url }) {
  let f = flags;
  try {
    const event = handoffEvent(project, reply, flags);
    if (event) {
      let page = "";
      try { const u = new URL(url); page = `${u.origin}/?project=${encodeURIComponent(project.id || "")}`; } catch {}
      f = [...flags, ...(await runHandoffActions(env, CONFIG, { project, event, question, reply, history, flags, who, url: page }))];
    }
  } catch (err) {
    console.error("handoff action failed (continuing)", err);
  }
  await logTurn(env, project, question, reply, f, who);
  // Leads: after this visitor's Nth turn (config.leads.autoAfterTurns), write
  // the summary and push it to the webhook if the score clears the bar. Runs
  // AFTER the row is logged so the summary sees this turn too.
  const leadFlags = await maybeAutoLead(env, CONFIG, project, who);
  if (leadFlags.length) console.log(JSON.stringify({ event: "lead-auto", visitor: who, flags: leadFlags }));
}

// --- Leads (admin): the visitors who gave an email, and what they wanted. -------
//   GET  /api/admin/leads?project=<id|*>&limit=100     the list
//   GET  /api/admin/leads/<visitor>                    turns + stored summary
//   POST /api/admin/leads/<visitor>/summarise[?refresh=1]
//   POST /api/admin/leads/<visitor>/send               push to the bot's webhook
async function handleLeads(request, env, url) {
  if (!env.DB) return json({ enabled: false, reason: "No D1 database is bound (wrangler.jsonc → d1_databases), so there is nothing to list. Turns still go to Workers Logs.", rows: [] });
  await ensureSchema(env);
  const parts = url.pathname.split("/").filter(Boolean);        // api, admin, leads, <visitor>, <action>
  const settings = leadsConfig(CONFIG);
  const projectId = String(url.searchParams.get("project") || "*");
  const project = projectId === "*" ? null : await resolveProject(env, projectId);
  try {
    if (parts.length === 3 && request.method === "GET") {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);
      return json({ ...(await listLeads(env, { projectName: project ? project.name : "*", limit })), settings: { ...settings, webhook: settings.webhook ? "set" : "" }, emailMode: /email/.test(CONFIG.access?.mode || ""), note: "The summary reads the redacted log (emails, phones and dates inside messages are already replaced). Names are not redacted. The visitor column is the email they typed; nobody verified it." });
    }
    const visitor = cleanVisitor(decodeURIComponent(parts[3] || ""));
    if (!visitor) return json({ error: "which visitor?" }, 400);
    const action = parts[4] || "";
    if (!action && request.method === "GET") { const lead = await getLead(env, CONFIG, visitor); return lead ? json(lead) : json({ error: "no such visitor" }, 404); }
    if (action === "summarise" && request.method === "POST") {
      const lead = await summariseLead(env, CONFIG, visitor, { refresh: ["1", "true"].includes(String(url.searchParams.get("refresh") || "")) });
      return json(lead, lead.error ? 422 : 200);
    }
    if (action === "send" && request.method === "POST") {
      const lead = await getLead(env, CONFIG, visitor);
      if (!lead?.summary) return json({ error: "Summarise first — there is nothing to send yet." }, 400);
      const bot = project || await resolveProject(env, (await resolveList(env)).find((p) => p.name === lead.bot)?.id || "");
      const result = await sendLead(env, CONFIG, lead, { project: bot });
      return json({ result, webhook: bot?.handoffActions?.webhook ? "bot" : settings.webhook ? "config" : "none" }, result === "lead-webhook-failed" ? 502 : 200);
    }
  } catch (err) {
    console.error("leads request failed", err);
    return json({ error: "Leads hit an error: " + String(err?.message || err).slice(0, 200) }, 500);
  }
  return json({ error: "method" }, 405);
}

// One character over and over, or one word over and over, is not an answer.
function isDegenerate(text) {
  const t = String(text).trim();
  if (t.length < 12) return false;
  const chars = t.replace(/\s+/g, "");
  const top = [...new Set(chars)].map((c) => chars.split(c).length - 1).sort((a, b) => b - a)[0] || 0;
  if (top / chars.length > 0.8) return true;                         // "!!!!!!!!!!!!"
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const counts = {}; for (const w of words) counts[w] = (counts[w] || 0) + 1;
  return Math.max(...Object.values(counts)) / words.length > 0.6;     // "Quick Quick Quick Quick…"
}

// --- Audit log (optional D1). Fail-open: no DB bound = no logging. ------------
// The single most useful thing your bot produces is a record of what people
// asked and what it couldn't answer. Every refusal is a page your site should have.
async function logTurn(env, project, question, answer, flags, who = "") {
  const refused = flags.some((f) => /blocked|error/.test(f)) || answer.includes("rather not guess") || answer.includes("don't have a solid answer");
  // Always goes to Workers Logs (dashboard → Worker → Logs). The visitor email is
  // kept on purpose in email mode; the question and answer are redacted.
  console.log(JSON.stringify({ event: "turn", project: project.name, who, refused, flags, asked: redact(question).slice(0, 200) }));
  if (!env.DB) return;
  try {
    await ensureSchema(env);
    await env.DB.prepare(
      `INSERT INTO conversations (project, visitor, asked, answered, refused, flags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(project.name, who, redact(question), redact(answer), refused ? 1 : 0, flags.join(","), new Date().toISOString()).run();
  } catch (err) {
    console.error("log failed (continuing)", err);
  }
}

// --- Saved projects: the Configure screen writes to D1; a saved bot with the same
//     id overrides the folder version. Folders remain what you commit to GitHub.
const OVERRIDABLE = ["1-identity.md", "2-capabilities.md", "3-personality.md", "4-formatting.md", "5-owner-instructions-intro.md", "6-files-strict.md", "6-files-open.md", "7-answering-strict.md", "7-answering-open.md", "8-links.md", "9-boundaries.md"];
let SAVED_CACHE = { at: 0, map: {} };
async function savedProjects(env) {
  if (!env.DB) return {};
  if (Date.now() - SAVED_CACHE.at < 15000) return SAVED_CACHE.map;
  try {
    await ensureSchema(env);
    const rows = (await env.DB.prepare(`SELECT id, json FROM projects`).all()).results || [];
    const map = {};
    for (const r of rows) { try { map[r.id] = normaliseProject(JSON.parse(r.json), r.id); } catch {} }
    SAVED_CACHE = { at: Date.now(), map };
  } catch (err) { console.error("saved projects read failed", err); }
  return SAVED_CACHE.map;
}
function normaliseProject(p, id) {
  const clean = (t) => String(t || "").replace(/<!--[\s\S]*?-->/g, "").trim();
  return {
    id, order: Number(p.order ?? 100),
    name: String(p.name || id).slice(0, 80), tagline: String(p.tagline || "").slice(0, 200), greeting: String(p.greeting || "").slice(0, 400),
    starters: (Array.isArray(p.starters) ? p.starters : []).map((x) => String(x).slice(0, 120)).filter(Boolean).slice(0, 4),
    mode: MODES[p.mode] ? p.mode : "answer", grounding: p.grounding === "open" ? "open" : "strict",
    handoffText: String(p.handoffText || "").slice(0, 300), handoffContact: String(p.handoffContact || "").slice(0, 300),
    handoffActions: normaliseHandoffActions(p.handoffActions),   // { webhook, email, on } — Engine/worker/handoff.js
    allowedLinks: (Array.isArray(p.allowedLinks) ? p.allowedLinks : []).map((x) => String(x).trim()).filter((x) => /^https?:\/\//.test(x)).slice(0, 40),
    thinkingWords: (Array.isArray(p.thinkingWords) ? p.thinkingWords : []).map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 40),
    intakeQuestions: (Array.isArray(p.intakeQuestions) ? p.intakeQuestions : []).map((x) => String(x).slice(0, 200)).slice(0, 10),
    bookingUrl: String(p.bookingUrl || ""), bookingFitRules: String(p.bookingFitRules || "").slice(0, 2000),
    nextSteps: (Array.isArray(p.nextSteps) ? p.nextSteps : []).slice(0, 10),
    // the bot's website (optional): one URL, and glob patterns for which pages to keep / skip
    website: normaliseWebsite(p.website),
    instructions: clean(p.instructions).slice(0, 20000),
    files: Object.fromEntries(Object.entries(p.files || {}).filter(([n]) => /^[\w. -]{1,80}\.(md|txt|csv)$/i.test(n)).map(([n, t]) => [n, clean(t).slice(0, 200000)]).slice(0, 40)),
    // this bot's own copies of root prompt/ files (same names) — the folder-wins rule, from the form
    prompt: Object.fromEntries(Object.entries(p.prompt || {}).filter(([n]) => OVERRIDABLE.includes(n) || /^jobs\/[a-z-]+\.md$/.test(n)).map(([n, t]) => [n, clean(t).slice(0, 20000)]).filter(([, t]) => t.length > 0)),
  };
}
function normaliseWebsite(w) {
  const globs = (v) => (Array.isArray(v) ? v : String(v || "").split(/[\n,]/)).map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 10);
  const url = String(w?.url || "").trim().slice(0, 500);
  const sitemap = String(w?.sitemap || "").trim().slice(0, 500);
  return { url: /^https?:\/\/\S+$/i.test(url) ? url : "", include: globs(w?.include), exclude: globs(w?.exclude), ...(sitemap ? { sitemap } : {}) };
}
async function resolveProject(env, id) {
  const saved = await savedProjects(env);
  if (id && saved[id]) return saved[id];
  if (id && PROJECTS[id]) return { id, ...folderProject(id, CONFIG.defaultProject) };
  return saved[CONFIG.defaultProject] || { id: CONFIG.defaultProject, ...folderProject(CONFIG.defaultProject, CONFIG.defaultProject) };
}

// --- The library: this bot's documents in AI Search. Admin only; every upload
//     is scanned first (Engine/worker/library.js). ---------------------------------
async function handleLibrary(request, env, url) {
  const raw = String(url.searchParams.get("project") || "");
  // The audit needs D1, not AI Search, and takes "*" for every bot — so it goes first.
  if (request.method === "GET" && url.pathname === "/api/admin/library/audit") return json(await libraryAudit(env, raw, url.searchParams.get("limit")));
  const bot = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  if (!bot) return json({ error: "which bot? add ?project=<id>" }, 400);
  const meta = libraryMeta(env, CONFIG);
  if (!meta.enabled) return json({ error: "The library isn't switched on: wrangler.jsonc needs the ai_search_namespaces binding and YourBots/config.js → library.name. See docs/CUSTOMIZE.md → Give it documents.", ...meta }, 503);
  try {
    // --- The website: GET = where it stands · POST = crawl now · DELETE = forget it.
    //     The URL comes from the saved bot; the form can send an unsaved one in the
    //     body so "Crawl now" works before "Save" (the chat only uses it once saved).
    if (url.pathname === "/api/admin/library/crawl") {
      const project = await resolveProject(env, bot);
      let site = websiteOf(project);
      if (request.method === "POST") {
        let b = {}; try { b = await request.json(); } catch {}
        if (b && typeof b.website === "object") site = websiteOf({ website: normaliseWebsite(b.website) }) || site;
        if (!site) return json({ error: "This bot has no website URL. Configure → Website, or project.json → website.url." }, 400);
        const r = await crawlWebsite(env, CONFIG, bot, site);
        console.log(JSON.stringify({ event: "website-crawl", bot, url: site.url, instance: r.name, created: r.created, recreated: r.recreated }));
        return json({ ok: true, ...r, status: await websiteStatus(env, CONFIG, bot, site) });
      }
      if (request.method === "DELETE") return json({ ok: true, removed: await deleteWebsite(env, CONFIG, bot) });
      if (request.method === "GET") return json(await websiteStatus(env, CONFIG, bot, site));
      return json({ error: "method" }, 405);
    }
    if (request.method === "GET" && url.pathname === "/api/admin/library") return json({ ...meta, files: await listFiles(env, CONFIG, bot) });
    if (request.method === "POST" && url.pathname === "/api/admin/library") {
      const form = await request.formData();
      const files = form.getAll("file").filter((f) => f && typeof f.arrayBuffer === "function");
      if (!files.length) return json({ error: "No file in the request. Send multipart/form-data with a 'file' field." }, 400);
      const override = ["1", "true", "yes"].includes(String(form.get("override") || "").toLowerCase());
      const source = String(form.get("source") || "upload");   // "github" = the sync action owns it
      const who = source === "github" ? "github" : "admin";     // the only two things that upload today
      const results = [];
      for (const f of files.slice(0, 10)) {
        const res = await uploadFile(env, CONFIG, bot, f.name, await f.arrayBuffer(), { override, source });
        // The override is the one thing worth a permanent line in the logs.
        if (override && res.ok) console.log(JSON.stringify({ event: "library-override", bot, file: res.name }));
        // …and every outcome gets a row in the audit table (when D1 is bound).
        if (res.ok) await logLibraryEvent(env, bot, res.name, override ? "override" : "upload", "", who);
        else if (res.needsOverride) await logLibraryEvent(env, bot, res.name, "held", JSON.stringify(res.flagged), who);
        results.push(res);
      }
      return json({ results });
    }
    // Scan again: every document, same checks as an upload, nothing changed.
    if (request.method === "POST" && url.pathname === "/api/admin/library/rescan") {
      const r = await rescanLibrary(env, CONFIG, bot);
      for (const f of r.results) if (f.flagged.length) await logLibraryEvent(env, bot, f.name, "rescan-held", JSON.stringify(f.flagged), "admin");
      return json({ ...r, scanWithModel: meta.scanWithModel });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/library/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/admin/library/".length));
      const gone = await deleteFile(env, CONFIG, bot, id);
      if (!gone) return json({ error: "no such file for this bot" }, 404);
      await logLibraryEvent(env, bot, gone.name, "remove", "", "admin");
      return json({ ok: true });
    }
    // The original file back out (admin only) — what Commit to GitHub writes into the repo.
    if (request.method === "GET" && /^\/api\/admin\/library\/[^/]+\/download$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[4]);
      const d = await downloadFile(env, CONFIG, bot, id);
      if (!d) return json({ error: "no such file for this bot" }, 404);
      return new Response(d.bytes, { headers: { "content-type": d.contentType || "application/octet-stream", "content-disposition": `attachment; filename="${d.name.split("/").pop().replace(/"/g, "")}"` } });
    }
  } catch (err) {
    console.error("library request failed", err);
    return json({ error: "The library hit an error: " + String(err?.message || err).slice(0, 200) }, 500);
  }
  return json({ error: "method" }, 405);
}
// --- The scan's own record. What was held, what was put in anyway, what was
//     removed — durable, in D1, next to the conversations. Fail-open: no DB, no
//     row, no error. Workers Logs still get the override line above.
//     event: held | override | upload | remove | rescan-held
//     detail: for held/rescan-held, the JSON list the admin was shown (labels, counts, masked samples)
//     who: "admin" (Configure) or "github" (the sync action)
async function logLibraryEvent(env, bot, file, event, detail = "", who = "admin") {
  if (!env.DB) return;
  try {
    await ensureSchema(env);
    await env.DB.prepare(`INSERT INTO library_events (bot, file, event, detail, who, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(bot, file, event, String(detail || "").slice(0, 4000), who, new Date().toISOString()).run();
  } catch (err) { console.error("library event log failed (continuing)", err?.message || err); }
}

// GET /api/admin/library/audit?project=<bot>&limit=100 — newest first. project=* for every bot.
async function libraryAudit(env, project, limitRaw) {
  if (!env.DB) return { enabled: false, rows: [], reason: "No D1 database is bound (wrangler.jsonc → d1_databases). Overrides still go to Workers Logs." };
  await ensureSchema(env);
  const limit = Math.min(Math.max(parseInt(limitRaw || "100", 10) || 100, 1), 500);
  const all = !project || project === "*";
  const bot = project.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  const sql = `SELECT id, bot, file, event, detail, who, created_at FROM library_events ${all ? "" : "WHERE bot = ?"} ORDER BY id DESC LIMIT ?`;
  const stmt = all ? env.DB.prepare(sql).bind(limit) : env.DB.prepare(sql).bind(bot, limit);
  const rows = ((await stmt.all()).results || []).map((r) => { let detail = []; try { detail = r.detail ? JSON.parse(r.detail) : []; } catch { detail = []; } return { ...r, detail }; });
  return { enabled: true, rows };
}

async function resolveList(env) {
  const saved = await savedProjects(env);
  const folder = folderList().map((p) => ({ ...p, source: saved[p.id] ? "saved (overrides folder)" : "folder" }));
  const extra = Object.values(saved).filter((p) => !PROJECTS[p.id]).map((p) => ({ id: p.id, name: p.name, tagline: p.tagline, greeting: p.greeting, starters: p.starters, mode: p.mode, grounding: p.grounding, thinkingWords: p.thinkingWords.length ? p.thinkingWords : undefined, order: p.order, source: "saved" }));
  const merged = [...folder.map((p) => saved[p.id] ? { ...p, ...pickPublic(saved[p.id]), source: p.source } : p), ...extra];
  return merged.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || String(a.name).localeCompare(String(b.name)));
}
function pickPublic(p) { return { name: p.name, tagline: p.tagline, greeting: p.greeting, starters: p.starters, mode: p.mode, grounding: p.grounding, thinkingWords: p.thinkingWords.length ? p.thinkingWords : undefined, order: p.order }; }

// The audit table creates itself the first time it's needed (no schema step for
// attendees). Engine/schema.sql is the same DDL, kept for reading; this is the source.
let SCHEMA_OK = false;
async function ensureSchema(env) {
  if (SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, visitor TEXT, asked TEXT, answered TEXT, refused INTEGER DEFAULT 0, flags TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_conv_refused ON conversations(refused)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    // What the document scan did: held / override / upload / remove / rescan-held. See logLibraryEvent.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS library_events (id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT, file TEXT, event TEXT NOT NULL, detail TEXT, who TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_libev_bot ON library_events(bot, id)`),
    // Leads: one row per visitor email, with the stored AI summary. See Engine/worker/leads.js.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS leads (visitor TEXT PRIMARY KEY, bot TEXT, summary TEXT, score INTEGER, updated_at TEXT NOT NULL, turns_at_summary INTEGER DEFAULT 0, sent_at TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_conv_visitor ON conversations(visitor, id)`),
  ]);
  SCHEMA_OK = true;
}

// Under the hood → Audit. Who asked what, what the bot said, what the firewall did.
async function auditView(env, q) {
  if (!env.DB) return { enabled: false, reason: "No D1 database is bound (wrangler.jsonc → d1_databases). Turns still go to Workers Logs." };
  await ensureSchema(env);
  const project = String(q.get("project") || "");
  const filter = String(q.get("filter") || "all");           // all | refused | flagged | visitor:<email>
  const limit = Math.min(Math.max(parseInt(q.get("limit") || "50", 10) || 50, 1), 200);
  const where = []; const args = [];
  if (project && project !== "*") { const meta = await resolveProject(env, project); where.push("project = ?"); args.push(meta.name); }
  if (filter === "refused") where.push("refused = 1");
  if (filter === "flagged") where.push("flags != ''");
  if (filter.startsWith("visitor:")) { where.push("visitor = ?"); args.push(filter.slice(8).toLowerCase()); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = (await env.DB.prepare(`SELECT id, project, visitor, asked, answered, refused, flags, created_at FROM conversations ${W} ORDER BY id DESC LIMIT ?`).bind(...args, limit).all()).results || [];
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const stats = (await env.DB.prepare(`SELECT COUNT(*) turns, SUM(refused) refused, SUM(CASE WHEN flags != '' THEN 1 ELSE 0 END) flagged, COUNT(DISTINCT visitor) visitors FROM conversations WHERE created_at >= ?`).bind(since).first()) || {};
  const top = (await env.DB.prepare(`SELECT asked, COUNT(*) n FROM conversations WHERE refused = 1 AND created_at >= ? GROUP BY asked ORDER BY n DESC LIMIT 10`).bind(since).all()).results || [];
  return { enabled: true, rows, stats: { ...stats, since }, topRefused: top, note: "Emails, phone numbers and dates inside questions and answers are redacted before storage. Names are not. The visitor column is kept on purpose in email mode." };
}

// --- Commit a bot's folder to GitHub (Contents API). One commit per file; files
//     that no longer exist in the bot are deleted from the folder. Needs the
//     GITHUB_TOKEN secret (fine-grained, Contents read/write, this repo only).
function exportFiles(p, id) {
  const { instructions, files, prompt, id: _i, ...meta } = p;
  const out = { [`YourBots/${id}/project.json`]: JSON.stringify(meta, null, 2) + "\n", [`YourBots/${id}/instructions.md`]: (instructions || "") + "\n" };
  for (const [n, t] of Object.entries(files || {})) out[`YourBots/${id}/knowledge/${n}`] = t + "\n";
  for (const [n, t] of Object.entries(prompt || {})) out[`YourBots/${id}/prompt/${n}`] = t + "\n";
  return out;
}
async function syncToGitHub(env, id) {
  const repo = CONFIG.github?.repo, branch = CONFIG.github?.branch || "main";
  if (!repo) return { error: "YourBots/config.js → github.repo is empty" };
  if (!env.GITHUB_TOKEN) return { error: "GITHUB_TOKEN secret is not set (fine-grained token, Contents: read & write, only this repo)" };
  const p = await resolveProject(env, id);
  if (!p || (p.id && p.id !== id && !PROJECTS[id])) return { error: "unknown bot" };
  const want = exportFiles(p, id);                    // text: project.json, instructions, knowledge/*.md|txt|csv, prompt/*
  const gh = async (path, init = {}) => {
    const r = await fetch(`https://api.github.com/repos/${repo}/${path}`, { ...init, headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "bot-you-own", "content-type": "application/json", ...(init.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  };
  // existing files in the folder → sha map (and what to delete)
  const existing = {};
  const walk = async (dir) => {
    const r = await gh(`contents/${dir}?ref=${encodeURIComponent(branch)}`);
    if (!r.ok || !Array.isArray(r.body)) return;
    for (const e of r.body) { if (e.type === "file") existing[e.path] = e.sha; else if (e.type === "dir") await walk(e.path); }
  };
  await walk(`YourBots/${id}`);

  // --- The library's documents ride along, so the folder holds the same PDFs
  //     the bot answers from. Each one is the original bytes, written under
  //     knowledge/. Overrides go into knowledge/APPROVED.txt so the sync action
  //     (which re-scans everything it uploads) doesn't hold them back again.
  const docs = {};                                    // path → { bytes }
  const docErrors = [];
  let approvedNames = [];
  if (libraryMeta(env, CONFIG).enabled) {
    try {
      for (const f of await listFiles(env, CONFIG, id)) {
        if (f.status === "error" || f.status === "skipped") { docErrors.push(`${f.name}: not committed (status ${f.status})`); continue; }
        try {
          const d = await downloadFile(env, CONFIG, id, f.id);
          if (d) { docs[`YourBots/${id}/knowledge/${f.name}`] = { bytes: d.bytes }; if (f.approved) approvedNames.push(f.name); }
        } catch (err) { docErrors.push(`${f.name}: download failed (${String(err?.message || err).slice(0, 80)})`); }
      }
    } catch (err) { docErrors.push(`library list failed: ${String(err?.message || err).slice(0, 120)}`); }
  }
  const approvedPath = `YourBots/${id}/knowledge/APPROVED.txt`;
  if (approvedNames.length) {
    let current = "";
    if (existing[approvedPath]) { const r = await gh(`contents/${approvedPath}?ref=${encodeURIComponent(branch)}`); if (r.ok && r.body?.content) current = atob(String(r.body.content).replace(/\n/g, "")); }
    const lines = current.split(/\r?\n/);
    const have = new Set(lines.map((l) => l.trim()));
    const add = approvedNames.filter((n) => !have.has(n));
    if (add.length) want[approvedPath] = (current.trim() ? current.replace(/\s*$/, "\n") : "# Files the upload scan held back and you approved. One filename per line.\n") + add.join("\n") + "\n";
  }

  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64bytes = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  // git's blob id, so an unchanged PDF isn't re-committed every time.
  const blobSha = async (buf) => { const head = new TextEncoder().encode(`blob ${buf.byteLength}\0`); const all = new Uint8Array(head.length + buf.byteLength); all.set(head); all.set(new Uint8Array(buf), head.length); return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map((b) => b.toString(16).padStart(2, "0")).join(""); };

  const committed = [], unchanged = [], deleted = [], errors = [...docErrors];
  let lastCommit = "";
  const put = async (path, content, isText) => {
    const r = await gh(`contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `${existing[path] ? "update" : "add"} ${path} (from Configure)`, content, branch, ...(existing[path] ? { sha: existing[path] } : {}) }) });
    if (r.ok) { committed.push(path); lastCommit = r.body?.commit?.html_url || lastCommit; }
    else if (r.status === 422 && /same/i.test(JSON.stringify(r.body))) unchanged.push(path);
    else errors.push(`${path}: ${r.status} ${r.body?.message || ""}`);
  };
  for (const [path, content] of Object.entries(want)) await put(path, b64(content), true);
  for (const [path, { bytes }] of Object.entries(docs)) {
    if (existing[path] && existing[path] === (await blobSha(bytes))) { unchanged.push(path); continue; }
    await put(path, b64bytes(bytes), false);
  }

  // Delete what the form no longer has. Text files and prompt overrides are fully
  // represented above, so a missing one was removed on purpose. Documents are
  // deleted only when the library was read successfully (otherwise a hiccup in
  // AI Search would wipe the repo's PDFs). APPROVED.txt is never deleted.
  const libraryRead = libraryMeta(env, CONFIG).enabled && !docErrors.some((e) => e.startsWith("library list failed"));
  const isText = (path) => /\.(md|txt|csv|json)$/i.test(path);
  const leftAlone = [];
  for (const path of Object.keys(existing)) {
    if (want[path] || docs[path] || path === approvedPath) continue;
    const doc = path.startsWith(`YourBots/${id}/knowledge/`) && !isText(path);
    if (doc && !libraryRead) { leftAlone.push(path); continue; }
    const r = await gh(`contents/${path}`, { method: "DELETE", body: JSON.stringify({ message: `remove ${path} (from Configure)`, sha: existing[path], branch }) });
    if (r.ok) { deleted.push(path); lastCommit = r.body?.commit?.html_url || lastCommit; } else errors.push(`delete ${path}: ${r.status}`);
  }
  return { ok: errors.length === 0, repo, branch, committed, deleted, unchanged, leftAlone, documents: Object.keys(docs).length, errors, commitUrl: lastCommit, note: "The folder is now in the repo, documents included. If the repo is connected to Cloudflare Workers Builds, this commit redeploys the bot in about a minute, and the Sync library action re-files the documents from the repo (they show as 'from GitHub' afterwards — the repo is now their source). The saved copy stays live meanwhile; remove it once the deploy lands so the folder is the single source." };
}

// The version stamp written by scripts/snapshot-src.mjs at build time.
let VERSION_CACHE = null;
async function versionStamp(env) {
  if (VERSION_CACHE) return VERSION_CACHE;
  try { VERSION_CACHE = await (await env.ASSETS.fetch(new Request("https://x/version.json"))).json(); }
  catch { VERSION_CACHE = { version: "dev", builtAt: "", commit: "" }; }
  return VERSION_CACHE;
}

// "Under the hood": everything the admin view shows, for one project.
async function engineView(env, projectId) {
  const project = await resolveProject(env, String(projectId || ""));
  const prompt = buildSystemPrompt({ config: CONFIG, project });
  let sources = [];
  try { sources = await (await env.ASSETS.fetch(new Request("https://x/engine/index.json"))).json(); } catch {}
  const { files, instructions, ...meta } = project;
  const libMeta = libraryMeta(env, CONFIG);
  const library = { ...libMeta, name: CONFIG.library?.name || "", files: [] };
  if (libMeta.enabled) { try { library.files = await listFiles(env, CONFIG, project.id || String(projectId || "")); } catch (err) { library.error = String(err?.message || err); } }
  // the website crawl, if this bot has one (null = no URL set)
  library.website = websiteOf(project) ? await websiteStatus(env, CONFIG, project.id || String(projectId || ""), websiteOf(project)) : null;
  return {
    project: { id: projectId, ...meta, instructions },
    library,
    prompt: prompt.text,
    promptFiles: PROMPT_FILES.map((f) => f.replace("<mode>", project.mode || "answer")),
    promptChars: prompt.text.length,
    promptTokensApprox: Math.round(prompt.text.length / 4),
    files,
    mode: MODES[project.mode] || MODES.answer,
    firewall: {
      config: CONFIG.firewall,
      rateLimit: env.RATE_LIMITER ? "on (wrangler.jsonc → ratelimits)" : "off (no binding)",
      door: env.ACCESS_PASSPHRASE ? "locked (ACCESS_PASSPHRASE set)" : "open",
      injectionPatterns: INJECTION_PATTERNS.map(String),
      secretPatterns: SECRET_PATTERNS.map(String),
      llamaGuardModel: LLAMA_GUARD_MODEL,
      logging: env.DB ? "on (D1 bound) — see the Audit tab" : "off (no D1 binding; Workers Logs only)",
      flags: {
        "injection-blocked": "matched an injection pattern; model never called",
        "invisible-text-stripped": "zero-width / bidi characters removed",
        "secret-detected": "looks like a key, card or SSN was pasted (logged only)",
        "link-stripped": "a URL not in allowedLinks was removed after the answer",
        "leak-blocked": "answer repeated the protected prompt; withheld",
        "leak-blocked:paraphrase": "answer described its rules in its own words; withheld",
        "handoff-appended": "a decline in a strict project was missing the contact; added",
        "intake-complete": "an intake bot collected everything (the [INTAKE COMPLETE] line was found and removed)",
        "handoff-webhook-sent / handoff-webhook-failed": "the bot's handoff webhook was called after the reply; Audit tab only",
        "handoff-email-sent / -failed / -skipped": "the handoff email; skipped = no send_email binding or no handoffEmailFrom",
        "library-used": "excerpts from this bot's documents (AI Search) were put in the prompt for this question",
        "degenerate-reply": "the model emitted one character or one word over and over, twice; replaced with the handoff",
        "degenerate-retried": "the first reply was garbage; a second call gave a proper answer",
        "attachment-used": "the visitor's attached file was put in the prompt (outside <files>; never a fact about the business)",
        "attachment-injection-blocked": "the attached file contained instructions for the bot; refused before the model",
        "attachment-secret-blocked": "the attached file looked like it held a card number, key or ID number; refused",
        "website-used": "excerpts from this bot's crawled website (AI Search web crawler) were put in the prompt for this question",
        "guard-blocked:S#": "Llama Guard flagged the user turn (category S1–S14)",
        "gateway-blocked": "AI Gateway Guardrails blocked it at the edge",
        "rate-limited": "over the per-visitor limit",
      },
    },
    gateway: { provider: CONFIG.provider, model: CONFIG.model, maxTokens: CONFIG.maxTokens, gateway: CONFIG.gateway },
    handoffActions: handoffActionsView(env, CONFIG, project),
    version: await versionStamp(env),
    sources,
  };
}

function sseOnce(reply, flags) {
  const payload = `data: ${JSON.stringify({ type: "final", text: reply, flags })}\n\n`;
  return new Response(payload, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
