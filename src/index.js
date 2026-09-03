import { CONFIG } from "../config.js";
import { getProject, listProjects } from "../projects/index.js";
import { buildSystemPrompt } from "./prompt.js";
import { complete } from "./gateway.js";
import { screenInbound, screenOutbound, llamaGuard, redact } from "./firewall.js";

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

    if (url.pathname === "/health") return new Response("ok");

    // --- THE DOOR. If the ACCESS_PASSPHRASE secret is set, the bot is locked:
    //     /api/config hides the projects and /api/chat refuses without a token.
    //     Unset = a public bot. See DEPLOY.md → "Lock it".
    const locked = Boolean(env.ACCESS_PASSPHRASE);
    const token = locked ? await accessToken(env) : null;
    const authed = !locked || safeEqual(request.headers.get("x-access-token") || "", token);

    if (url.pathname === "/api/unlock") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!locked) return json({ token: null, locked: false });
      if (!(await allowed(env, request))) return json({ error: "too many attempts" }, 429);
      let b; try { b = await request.json(); } catch { return json({ error: "bad request" }, 400); }
      const given = await accessToken({ ACCESS_PASSPHRASE: String(b.passphrase || "") });
      return safeEqual(given, token) ? json({ token, locked: true }) : json({ error: "wrong passphrase" }, 401);
    }

    if (url.pathname === "/api/config") {
      if (locked && !authed) return json({ locked: true, siteName: CONFIG.siteName, accent: CONFIG.accent });
      const all = listProjects();
      const projects = CONFIG.singleProject ? all.filter((p) => p.id === CONFIG.defaultProject) : all;
      return json({
        locked,
        owner: CONFIG.owner,
        siteName: CONFIG.siteName,
        accent: CONFIG.accent,
        model: CONFIG.model,
        provider: CONFIG.provider,
        defaultProject: CONFIG.defaultProject,
        projects: projects.length ? projects : all.slice(0, 1),
      });
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!authed) return json({ error: "locked", reply: "This bot is locked. Enter the passphrase to continue." }, 401);
      return handleChat(request, env, ctx);
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
async function accessToken(env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.ACCESS_PASSPHRASE || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("bot-you-own/access/v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleChat(request, env, ctx) {
  if (!(await allowed(env, request))) {
    return json({ reply: "You're sending messages faster than I can think. Give me a moment and try again.", flags: ["rate-limited"] }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }

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
    ctx.waitUntil(logTurn(env, project, last.content, reply, flags));
    return send(reply, flags);
  }

  // --- Optional: Llama Guard on the user's turn ------------------------------
  if (fw.llamaGuard) {
    const g = await llamaGuard(env, [{ role: "user", content: last.content }]);
    if (g.ran && !g.safe) {
      flags.push("guard-blocked:" + (g.categories.join(",") || "unspecified"));
      const reply = "I can't help with that. If you're in a difficult situation, please reach out to someone qualified to help.";
      ctx.waitUntil(logTurn(env, project, last.content, reply, flags));
      return send(reply, flags);
    }
  }

  // --- LAYER 1: build the prompt --------------------------------------------
  const prompt = buildSystemPrompt({ config: CONFIG, project });
  const outboundOpts = { allowedLinks: project.allowedLinks, protectedText: prompt.protectedText, config: CONFIG };

  // --- LAYER 3b: call the model through the gateway --------------------------
  let result;
  try {
    result = await complete({ env, config: CONFIG, system: prompt.text, messages: history, stream });
  } catch (err) {
    console.error("model call failed", err?.code || "", err?.message || err);
    const f = [...flags, err?.code === "gateway-blocked" ? "gateway-blocked" : err?.code === "rate-limited" ? "provider-rate-limited" : "model-error"];
    ctx.waitUntil(logTurn(env, project, last.content, handoff, f));
    return send(handoff, f);
  }

  // --- Non-streaming path -----------------------------------------------------
  if (!stream) {
    const out = await finish(String(result), { env, fw, flags, handoff, outboundOpts });
    ctx.waitUntil(logTurn(env, project, last.content, out.reply, out.flags));
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
        ctx.waitUntil(logTurn(env, project, last.content, out.reply, out.flags));
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
async function logTurn(env, project, question, answer, flags) {
  if (!env.DB) return;
  try {
    const refused = flags.some((f) => /blocked|error/.test(f)) || answer.includes("rather not guess") || answer.includes("don't have a solid answer");
    await env.DB.prepare(
      `INSERT INTO conversations (project, asked, answered, refused, flags, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(project.name, redact(question), redact(answer), refused ? 1 : 0, flags.join(","), new Date().toISOString()).run();
  } catch (err) {
    console.error("log failed (continuing)", err);
  }
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
