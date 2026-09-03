import { CONFIG } from "../config.js";
import { getProject, listProjects } from "../projects/index.js";
import { buildSystemPrompt } from "./prompt.js";
import { complete } from "./gateway.js";
import { screenInbound, screenOutbound, ensureHandoff, llamaGuard, redact, INJECTION_PATTERNS, SECRET_PATTERNS, LLAMA_GUARD_MODEL } from "./firewall.js";
import { MODES } from "./modes.js";

// ============================================================================
//  THE WORKER. Three routes and a static folder.
//    GET  /api/config   → what the page needs to draw itself
//    POST /api/chat     → { project, messages, stream } → SSE stream (or JSON)
//    GET  /health       → "ok"
//    *                  → public/ (the chat page, the widget)
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") { const v = await versionStamp(env); return new Response(`ok ${v.version} ${v.commit} ${v.builtAt}`.trim()); }

    // --- THE DOOR. If the ACCESS_PASSPHRASE secret is set, the bot is locked:
    //     /api/config hides the projects and /api/chat refuses without a token.
    //     Unset = a public bot. See DEPLOY.md → "Lock it".
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
      const all = listProjects();
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
      });
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!authed) return json({ error: "locked", reply: "This bot is locked. Enter the passphrase to continue." }, 401);
      return handleChat(request, env, ctx, { wantEmail, isAdmin });
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
//     also works inside the embed iframe (cookies don't — see CUSTOMIZE.md).
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

  const project = getProject(String(body.project || ""), CONFIG.defaultProject);
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
    ctx.waitUntil(logTurn(env, project, last.content, reply, flags, who));
    return send(reply, flags);
  }

  // --- Optional: Llama Guard on the user's turn ------------------------------
  if (fw.llamaGuard) {
    const g = await llamaGuard(env, [{ role: "user", content: last.content }]);
    if (g.ran && !g.safe) {
      flags.push("guard-blocked:" + (g.categories.join(",") || "unspecified"));
      const reply = "I can't help with that. If you're in a difficult situation, please reach out to someone qualified to help.";
      ctx.waitUntil(logTurn(env, project, last.content, reply, flags, who));
      return send(reply, flags);
    }
  }

  // --- LAYER 1: build the prompt --------------------------------------------
  const prompt = buildSystemPrompt({ config: CONFIG, project });
  const outboundOpts = { allowedLinks: project.allowedLinks, protectedText: prompt.protectedText, config: CONFIG, project };

  // --- LAYER 3b: call the model through the gateway --------------------------
  let result;
  try {
    result = await complete({ env, config: CONFIG, system: prompt.text, messages: history, stream });
  } catch (err) {
    console.error("model call failed", err?.code || "", err?.message || err);
    const f = [...flags, err?.code === "gateway-blocked" ? "gateway-blocked" : err?.code === "rate-limited" ? "provider-rate-limited" : "model-error"];
    ctx.waitUntil(logTurn(env, project, last.content, handoff, f, who));
    return send(handoff, f);
  }

  // --- Non-streaming path -----------------------------------------------------
  if (!stream) {
    const out = await finish(String(result), { env, fw, flags, handoff, outboundOpts });
    ctx.waitUntil(logTurn(env, project, last.content, out.reply, out.flags, who));
    return json({ reply: out.reply, flags: out.flags });
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
        const out = await finish(full, { env, fw, flags, handoff, outboundOpts });
        push({ type: "final", text: out.reply, flags: out.flags });
        ctx.waitUntil(logTurn(env, project, last.content, out.reply, out.flags, who));
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
async function finish(raw, { env, fw, flags, handoff, outboundOpts }) {
  const out = screenOutbound(raw.trim(), outboundOpts);
  let reply = out.text;
  const f = [...flags, ...out.flags];
  if (reply) {
    const h = ensureHandoff(reply, outboundOpts.project);
    if (h.added) { reply = h.text; f.push("handoff-appended"); }
  }
  if (reply && fw.llamaGuard) {
    const g = await llamaGuard(env, [{ role: "user", content: "(user message)" }, { role: "assistant", content: reply }]);
    if (g.ran && !g.safe) { f.push("guard-blocked-output:" + g.categories.join(",")); reply = ""; }
  }
  if (!reply) reply = handoff;
  return { reply, flags: f };
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

// The audit table creates itself the first time it's needed (no schema step for
// attendees). Same DDL as schema.sql, kept in one place here.
let SCHEMA_OK = false;
async function ensureSchema(env) {
  if (SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, visitor TEXT, asked TEXT, answered TEXT, refused INTEGER DEFAULT 0, flags TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_conv_refused ON conversations(refused)`),
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
  if (project && project !== "*") { const meta = getProject(project, CONFIG.defaultProject); where.push("project = ?"); args.push(meta.name); }
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
  const project = getProject(String(projectId || ""), CONFIG.defaultProject);
  const prompt = buildSystemPrompt({ config: CONFIG, project });
  let sources = [];
  try { sources = await (await env.ASSETS.fetch(new Request("https://x/engine/index.json"))).json(); } catch {}
  const { files, instructions, ...meta } = project;
  return {
    project: { id: projectId, ...meta, instructions },
    prompt: prompt.text,
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
        "guard-blocked:S#": "Llama Guard flagged the user turn (category S1–S14)",
        "gateway-blocked": "AI Gateway Guardrails blocked it at the edge",
        "rate-limited": "over the per-visitor limit",
      },
    },
    gateway: { provider: CONFIG.provider, model: CONFIG.model, maxTokens: CONFIG.maxTokens, gateway: CONFIG.gateway },
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
