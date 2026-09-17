// ============================================================================
//  THE TOUR — the five stops a visitor is walked through, and where they are.
//
//  A bot whose project.json has "tour": { "stops": [...] } is the guide (YourBots/tour).
//  The page draws a strip above the chat with the stops; stops are marked done by
//  what the person actually does (sent a message to a sample bot, tripped the
//  firewall, opened the code, clicked deploy or import, clicked the community),
//  kept on this browser AND, once they've signed up, on their row here — so the
//  Sign-ups tab shows how far each person got. That number is the funnel.
//
//    GET  /api/tour?bot=<guide>            → { stops, done, deploy: { allowed, url, why } }
//    POST /api/tour  { bot, stop }         → the same, after marking one stop
//
//  "Deploy your own" is for people on the allowlist (the guide bot's own list or
//  the deployment-wide one). Everyone else is shown the community instead.
// ============================================================================

import { identify } from "../identity/index.js";
import { isAllowed } from "./allowlist.js";
import { CONFIG } from "../../YourBots/config.js";

let SCHEMA_OK = false;
async function ensureSchema(env) {
  if (SCHEMA_OK || !env.DB) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tour_progress (user_id TEXT NOT NULL, bot TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, bot))`).run();
  SCHEMA_OK = true;
}
export const deployUrl = () => (CONFIG.github?.repo ? `https://deploy.workers.cloudflare.com/?url=https://github.com/${CONFIG.github.repo}` : "");

export async function tourState(env, request, guide, { stop = "" } = {}) {
  const stops = Array.isArray(guide?.tour?.stops) ? guide.tour.stops : [];
  let done = {}, user = null;
  if (env.DB) {
    await ensureSchema(env);
    try { user = (await identify(request, env, guide)).user; } catch {}
    if (user) {
      const row = await env.DB.prepare(`SELECT json FROM tour_progress WHERE user_id = ? AND bot = ?`).bind(user.id, guide.id).first();
      try { done = row ? JSON.parse(row.json) || {} : {}; } catch { done = {}; }
      if (stop && stops.includes(stop) && !done[stop]) {
        done[stop] = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO tour_progress (user_id, bot, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, bot) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).bind(user.id, guide.id, JSON.stringify(done), done[stop]).run();
      }
    }
  }
  // Deploy: on the guide's list, or the list for every bot.
  let deploy = { allowed: false, url: deployUrl(), why: "" };
  if (user && env.DB) {
    const a = await isAllowed(env, guide.id, user.email); const b = a.ok ? a : await isAllowed(env, "*", user.email);
    deploy.allowed = Boolean(b.ok);
    if (!deploy.allowed) deploy.why = "Deploying your own opens for community members.";
  } else deploy.why = "Sign up first, then deploying opens for community members.";
  return { stops, done, signedUp: Boolean(user), deploy, community: CONFIG.community?.show ? { name: CONFIG.community.name, url: CONFIG.community.url, pitch: CONFIG.community.pitch } : null };
}

// For the Sign-ups tab: how far each person got, keyed by user id. { id: { n, of } }
export async function tourProgressMap(env) {
  if (!env.DB) return {};
  await ensureSchema(env);
  const out = {};
  for (const r of (await env.DB.prepare(`SELECT user_id, bot, json FROM tour_progress`).all()).results || []) {
    try { const d = JSON.parse(r.json) || {}; out[r.user_id] = { n: Object.keys(d).length, bot: r.bot, stops: Object.keys(d) }; } catch {}
  }
  return out;
}
