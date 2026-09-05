// ============================================================================
//  SETTINGS — the deployment-wide knobs, read in ONE place with ONE merge order:
//
//      YourBots/config.js  <  YourBots/settings.json  <  the D1 "settings" rows
//
//  Later wins. config.js is what you ship; settings.json is what Settings →
//  Commit to GitHub wrote back into the repo; the D1 rows are what the Settings
//  screen saved (live at once, cached 10 s per isolate). If the database can't
//  be read, the last rows seen are kept — stale beats open — and failing that,
//  the files.
//
//  Three keys today, and the Settings screen edits exactly these:
//    access        { default, floor }        who can use a bot when it doesn't say
//    createYourOwn { show, text, url }       the badge under the chat
//    identity      { graceMinutes }          the return window (Engine/identity/devices.js);
//                                            a bot's own project.json → identity wins over this
// ============================================================================

import { CONFIG } from "../../YourBots/config.js";
import SETTINGS_FILE from "../../YourBots/settings.json";
import { accessSettings } from "./access.js";
import { cleanGrace, DEFAULT_GRACE_MINUTES } from "../identity/devices.js";

const KEYS = ["access", "createYourOwn", "identity"];
let CACHE = { at: 0, rows: null };

async function readRows(env) {
  if (!env.DB) return null;
  if (Date.now() - CACHE.at < 10000) return CACHE.rows;
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`).run();
    const rows = {};
    for (const r of (await env.DB.prepare(`SELECT key, json FROM settings`).all()).results || []) { if (KEYS.includes(r.key)) { try { rows[r.key] = JSON.parse(r.json); } catch {} } }
    CACHE = { at: Date.now(), rows };
  } catch (err) { console.error("settings read failed (keeping the last known)", err?.message || err); }
  return CACHE.rows;
}

// The one reader. Returns:
//   { default, floor, source: { default, floor } }   (the access shape every gate already uses)
//   + createYourOwn: { show, text, url, source }
export async function getSettings(env) {
  const rows = (await readRows(env)) || {};
  const access = accessSettings(CONFIG, SETTINGS_FILE, rows.access ? { access: rows.access } : null);
  const badge = mergeBadge(CONFIG.createYourOwn, SETTINGS_FILE?.createYourOwn, rows.createYourOwn);
  const identity = mergeIdentity(CONFIG.identity, SETTINGS_FILE?.identity, rows.identity);
  return { ...access, createYourOwn: badge, identity };
}
// identity.graceMinutes: the return window, in minutes. 0 = off. Same three places, later wins.
const graceOf = (i) => (i && typeof i === "object" && i.graceMinutes !== undefined && i.graceMinutes !== null && i.graceMinutes !== "" && Number.isFinite(Number(i.graceMinutes)) && Number(i.graceMinutes) >= 0 ? cleanGrace(i.graceMinutes) : null);
function mergeIdentity(c, f, s) {
  const pick = [graceOf(s), graceOf(f), graceOf(c)].find((v) => v !== null);
  const source = graceOf(s) !== null ? "saved (Settings screen)" : graceOf(f) !== null ? "YourBots/settings.json" : graceOf(c) !== null ? "YourBots/config.js" : "built-in";
  return { graceMinutes: pick === undefined ? DEFAULT_GRACE_MINUTES : pick, source };
}
export function cleanBadge(b) {
  if (!b || typeof b !== "object") return null;
  const url = String(b.url || "").trim().slice(0, 500);
  return { show: b.show !== false, text: String(b.text || "").slice(0, 80), url: /^https?:\/\//.test(url) ? url : "" };
}
function mergeBadge(c, f, s) {
  const pick = [cleanBadge(s), cleanBadge(f), cleanBadge(c)].find(Boolean);
  const source = cleanBadge(s) ? "saved (Settings screen)" : cleanBadge(f) ? "YourBots/settings.json" : cleanBadge(c) ? "YourBots/config.js" : "built-in";
  return { show: pick ? pick.show : true, text: pick?.text || "Create your own bot", url: pick?.url || "", source };
}

// The Settings screen's Save: one row per key, live within 10 s everywhere.
export async function saveSettings(env, { access, createYourOwn, identity } = {}) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`).run();
  const put = (key, obj) => env.DB.prepare(`INSERT INTO settings (key, json, updated_at, updated_by) VALUES (?, ?, ?, 'admin') ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(key, JSON.stringify(obj), new Date().toISOString());
  const ops = [];
  if (access) ops.push(put("access", { default: access.default, floor: access.floor }));
  if (createYourOwn) ops.push(put("createYourOwn", cleanBadge(createYourOwn)));
  if (identity && graceOf(identity) !== null) ops.push(put("identity", { graceMinutes: graceOf(identity) }));
  if (ops.length) await env.DB.batch(ops);
  CACHE = { at: 0, rows: null };
}

// What Settings → Commit to GitHub writes: the file half of the merge, as JSON.
export function settingsFileContent(s) {
  return JSON.stringify({ access: { default: s.default, floor: s.floor }, createYourOwn: { show: s.createYourOwn.show, text: s.createYourOwn.text, url: s.createYourOwn.url }, identity: { graceMinutes: s.identity?.graceMinutes ?? DEFAULT_GRACE_MINUTES } }, null, 2) + "\n";
}
export const SETTINGS_FILE_VIEW = SETTINGS_FILE;
