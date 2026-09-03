// ============================================================================
//  LAYER 3b — THE GATEWAY
//
//  One function: complete({ env, config, system, messages, stream }).
//  It talks to whichever model YourBots/config.js names, through Cloudflare AI Gateway
//  when a gateway id is set, and hands back either the full text or an async
//  iterator of text chunks.
//
//  Why a gateway at all: it's the dollar ceiling. AI Gateway gives you logs,
//  caching, a per-minute rate limit, a SPEND LIMIT in dollars, and Guardrails
//  (Llama Guard at the edge) — all from the dashboard, none of it in code.
//  See docs/DEPLOY.md. Fails open: if the gateway call errors, we retry without it.
//
//  Providers:
//    workers-ai  — no key. env.AI.run(). Default.
//    openai      — secret OPENAI_API_KEY. Chat Completions.
//    anthropic   — secret ANTHROPIC_API_KEY. Messages API.
// ============================================================================

export async function complete({ env, config, system, messages, stream = false }) {
  const provider = config.provider || "workers-ai";
  if (provider === "openai") return openai({ env, config, system, messages, stream });
  if (provider === "anthropic") return anthropic({ env, config, system, messages, stream });
  return workersAI({ env, config, system, messages, stream });
}

// ---------------------------------------------------------------- Workers AI
async function workersAI({ env, config, system, messages, stream }) {
  if (!env.AI) throw new Error("Workers AI binding missing (wrangler.jsonc → \"ai\")");
  const input = {
    messages: [{ role: "system", content: system }, ...messages],
    max_tokens: config.maxTokens || 900,
    stream,
  };
  const gw = config.gateway?.id
    ? { gateway: { id: config.gateway.id, skipCache: !(config.gateway.cacheTtl > 0), cacheTtl: config.gateway.cacheTtl || undefined } }
    : undefined;

  let result;
  try {
    result = gw ? await env.AI.run(config.model, input, gw) : await env.AI.run(config.model, input);
  } catch (err) {
    // Gateway Guardrails block: surface as a refusal, not a crash (codes 2016 / 2017).
    if (/2016|2017|blocked due to security/i.test(String(err?.message))) {
      const e = new Error("blocked-by-gateway"); e.code = "gateway-blocked"; throw e;
    }
    if (!gw) throw err;
    console.error("gateway call failed, retrying direct", err);
    result = await env.AI.run(config.model, input);
  }

  if (!stream) {
    return String(result?.response ?? result?.choices?.[0]?.message?.content ?? "");
  }
  // Streaming: Workers AI returns a ReadableStream of SSE lines.
  return sseTextChunks(result, (obj) => obj?.response ?? obj?.choices?.[0]?.delta?.content ?? "");
}

// ------------------------------------------------------------------- OpenAI
async function openai({ env, config, system, messages, stream }) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY secret not set");
  const base = gatewayBase(config, "openai") || "https://api.openai.com/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: config.maxTokens || 900,
      stream,
    }),
  });
  if (!res.ok) throw await httpError(res);
  if (!stream) {
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content ?? "");
  }
  return sseTextChunks(res.body, (obj) => obj?.choices?.[0]?.delta?.content ?? "");
}

// ---------------------------------------------------------------- Anthropic
// Raw Messages API over fetch (no SDK) so the Worker stays dependency-free and
// the request can be routed through AI Gateway's /anthropic path.
async function anthropic({ env, config, system, messages, stream }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY secret not set");
  const base = gatewayBase(config, "anthropic") || "https://api.anthropic.com";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      system,
      messages,
      max_tokens: config.maxTokens || 900,
      stream,
    }),
  });
  if (!res.ok) throw await httpError(res);
  if (!stream) {
    const data = await res.json();
    if (data?.stop_reason === "refusal") {
      const e = new Error("refusal"); e.code = "model-refusal"; throw e;
    }
    return (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  return sseTextChunks(res.body, (obj) =>
    obj?.type === "content_block_delta" && obj?.delta?.type === "text_delta" ? obj.delta.text : ""
  );
}

// ------------------------------------------------------------------ helpers
function gatewayBase(config, provider) {
  const { id, accountId } = config.gateway || {};
  if (!id || !accountId) return null;
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${id}/${provider}`;
}

async function httpError(res) {
  let detail = "";
  try { detail = (await res.text()).slice(0, 300); } catch {}
  const e = new Error(`${res.status} from provider: ${detail}`);
  if (res.status === 429) e.code = "rate-limited";
  return e;
}

// Turn an SSE body into an async iterator of text chunks.
async function* sseTextChunks(body, pick) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const text = pick(JSON.parse(payload));
        if (text) yield text;
      } catch { /* partial line; ignore */ }
    }
  }
}
