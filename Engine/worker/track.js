// ============================================================================
//  FOOD LOG — /food. A photo food log a coach deploys for their clients.
//
//  Not a chat bot: a page with a camera button. Snap the plate, the vision
//  model names the foods and guesses the numbers, the person fixes the
//  portion with a tap, the day shows a ring and three bars. Also: type a
//  meal, scan a barcode, read a nutrition label, scan a receipt, weigh in,
//  share a household with a spouse. The coach sees every client at /food/coach.
//
//  IDENTITY, in plain English (docs/FOOD-LOG.md says the same at length):
//   · A person types their email once. Their browser makes a random 32-byte
//     DEVICE KEY, keeps it in localStorage, and sends it with every request.
//     The server keeps only the SHA-256 of that key. That's the whole login:
//     "remembered forever on this browser", no passwords.
//   · The user id is SHA-256(lowercased email + FOODLOG_PEPPER). Same email,
//     same id, on any device — but knowing an email does NOT open the log.
//   · A SECOND browser typing the same email gets a 6-character code and a
//     message, not the log. The coach links it (Clients → link), or the
//     person proves the email with "Sign in with Google/Microsoft/Apple"
//     (track-signin.js verifies the ID token properly).
//   · Identity fails CLOSED: a bad or missing device key is a 401, always.
//     Features fail OPEN: no thumbnail, no barcode database, no model → the
//     page still works, with less.
//
//  ROUTES (all under /api/food/, device key in the x-device-key header):
//   GET  config                       what the page needs (coach name, sign-in buttons)
//   POST join {email}                 → { linked, userId } or { linked:false, code, message }
//   GET  me                           who am I, my targets, my household, still pending?
//   POST signin {provider, idToken}   link this device by proving the email
//   GET/POST targets                  daily kcal + macros (+ unit, name)
//   POST photo (multipart)            photo, thumb, kind=food|barcode|label|receipt, date, correction, mealId
//   POST text {text, date, correction, mealId}
//   POST meal {date, items, source}   · PATCH meal/<id> {items} · DELETE meal/<id>
//   GET  day?date=&user=              · GET week?end=&user=   (user= a household member, read-only)
//   POST barcode {code}               · POST weight {date, value, unit}
//   GET/POST household, POST household/join, POST household/leave
//   GET  receipts · DELETE receipt/<id>
//  Admin (x-admin-token): GET /api/admin/food/clients · GET client/<id> ·
//   GET export.csv · POST link {email, deviceCode}
//  Pages: /food (the app) · /food/coach (the coach view). Both are static
//  files in Engine/public/food/, served through here so foodLog.enabled=false
//  really does make them disappear.
// ============================================================================

import { CONFIG } from "../../YourBots/config.js";
import { foodLogConfig, json, sha256hex, nowIso, pickDate, addDays, todayUtc, randomCode, randomId, clamp, round1, cleanEmail, readJson, toBase64, DEV_PEPPER } from "./track-common.js";
import { runVision, PROMPTS, extractJson, sanitiseItems, sanitiseLabel, sanitiseReceipt, totalsOf, imageSize } from "./track-vision.js";
import { verifyIdToken } from "./track-signin.js";
import { lookupBarcode, rememberLabel, saveReceipt, listReceipts, deleteReceipt, setWeight, listWeights, householdOf, createHousehold, joinHousehold, leaveHousehold, canView } from "./track-extras.js";

const DEVICE_KEY_RE = /^[0-9a-f]{64}$/;
const THUMB_MAX_PX = 256, THUMB_MAX_BYTES = 48 * 1024;
const HONESTY = "Photo estimates are typically within about 30%. Fix the portion when it's off.";
const PENDING_TTL_MS = 7 * 864e5;

// --- The tables. Created on first use, like the rest of the Worker. ------------
let TRACK_SCHEMA_OK = false;
export async function ensureTrackSchema(env) {
  if (TRACK_SCHEMA_OK || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_users (id TEXT PRIMARY KEY, email TEXT UNIQUE, targets_json TEXT, created_at TEXT NOT NULL, last_seen TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_devices (key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_devices_user ON track_devices(user_id)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_pending (code TEXT PRIMARY KEY, key_hash TEXT NOT NULL, user_id_new TEXT, email TEXT NOT NULL, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_meals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, date TEXT NOT NULL, time TEXT, items_json TEXT NOT NULL, kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL, thumb TEXT, source TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_meals_day ON track_meals(user_id, date)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_usage (user_id TEXT NOT NULL, date TEXT NOT NULL, photos INTEGER DEFAULT 0, PRIMARY KEY (user_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_products (code TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_receipts (id TEXT PRIMARY KEY, household_id TEXT, user_id TEXT NOT NULL, store TEXT, date TEXT, total REAL, currency TEXT, items_json TEXT, thumb TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_receipts_h ON track_receipts(household_id, date)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_weights (user_id TEXT NOT NULL, date TEXT NOT NULL, kg REAL NOT NULL, PRIMARY KEY (user_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_households (id TEXT PRIMARY KEY, name TEXT, code TEXT UNIQUE, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_members (household_id TEXT NOT NULL, user_id TEXT PRIMARY KEY, name TEXT, joined_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_track_members_h ON track_members(household_id)`),
  ]);
  TRACK_SCHEMA_OK = true;
}

// --- The router. Called from index.js for /food*, /api/food/*, /api/admin/food/*.
export async function handleTrack(request, env, url, { isAdmin = false, adminEnabled = false, allowed = async () => true } = {}) {
  const cfg = foodLogConfig(CONFIG, env);
  const p = url.pathname;
  if (!cfg.enabled) return p.startsWith("/api/") ? json({ error: "not found" }, 404) : new Response("Not found", { status: 404 });

  // The pages. /food → the app; /food/coach → the coach view. Static files, gated here.
  if (p === "/food" || p === "/food/") return env.ASSETS.fetch(new Request(`${url.origin}/food/`, { headers: request.headers }));
  if (p.startsWith("/food/")) return env.ASSETS.fetch(request);

  if (p.startsWith("/api/admin/food/")) {
    if (!isAdmin) return json({ error: "admin only" }, adminEnabled ? 401 : 404);
    if (!env.DB) return json({ error: "No D1 database is bound (wrangler.jsonc → d1_databases)." }, 503);
    await ensureTrackSchema(env);
    return handleCoach(request, env, url, cfg);
  }

  if (p === "/api/food/config") return json({ enabled: true, name: String(cfg.name || "Plate"), coachName: cfg.coachName, honesty: HONESTY, signIn: cfg.signIn.filter((s) => s.clientId), dailyPhotoLimit: cfg.dailyPhotoLimit, maxPhotoBytes: cfg.maxPhotoBytes });
  if (!env.DB) return json({ error: "The food log needs the D1 database (wrangler.jsonc → d1_databases)." }, 503);
  await ensureTrackSchema(env);
  if (cfg.pepper === DEV_PEPPER) console.warn("FOODLOG_PEPPER is not set — user ids use the dev pepper. Set it before real people use this: npx wrangler secret put FOODLOG_PEPPER");

  const deviceKey = String(request.headers.get("x-device-key") || "");
  const keyHash = DEVICE_KEY_RE.test(deviceKey) ? await sha256hex(deviceKey) : null;

  if (p === "/api/food/join") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Too many tries. Give it a minute." }, 429);
    if (!keyHash) return json({ error: "no device key", reason: "This browser didn't send a device key. Reload the page." }, 400);
    return join(env, cfg, await readJson(request), keyHash);
  }

  // Everything below needs a known device. Unknown → 401, no exceptions.
  const me = keyHash ? await userForDevice(env, keyHash) : null;
  if (p === "/api/food/signin") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited" }, 429);
    if (!keyHash) return json({ error: "no device key" }, 400);
    return signIn(env, cfg, await readJson(request), keyHash, me);
  }
  if (p === "/api/food/me") {
    if (me) return json({ linked: true, ...(await profile(env, me)) });
    const pend = keyHash ? await env.DB.prepare(`SELECT code, email FROM track_pending WHERE key_hash = ?`).bind(keyHash).first() : null;
    return json(pend ? { linked: false, code: pend.code, email: pend.email, message: PENDING_MESSAGE } : { linked: false }, 401);
  }
  if (!me) return json({ error: "unknown device", reason: "This browser isn't linked to a log. Enter your email to start." }, 401);
  touch(env, me);

  const sub = p.slice("/api/food/".length);
  const body = request.method === "POST" || request.method === "PATCH" ? await readJson(request.clone()) : {};

  if (sub === "targets") {
    if (request.method === "GET") return json({ targets: me.targets });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const t = cleanTargets(body.targets || body);
    await env.DB.prepare(`UPDATE track_users SET targets_json = ? WHERE id = ?`).bind(JSON.stringify(t), me.id).run();
    return json({ ok: true, targets: t });
  }
  if (sub === "photo") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "You're sending photos faster than I can look. Give me a moment." }, 429);
    return photo(request, env, cfg, me);
  }
  if (sub === "text") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await allowed(env, request))) return json({ error: "rate-limited", reason: "Give me a moment and try again." }, 429);
    return textMeal(env, cfg, me, body);
  }
  if (sub === "meal" && request.method === "POST") return saveMeal(env, me, body);
  if (sub.startsWith("meal/")) {
    const id = sub.slice(5);
    const row = await env.DB.prepare(`SELECT id, user_id FROM track_meals WHERE id = ?`).bind(id).first();
    if (!row) return json({ error: "no such meal" }, 404);
    if (row.user_id !== me.id) return json({ error: "not yours", reason: "You can look at a household member's day, but only they can change it." }, 403);
    if (request.method === "DELETE") { await env.DB.prepare(`DELETE FROM track_meals WHERE id = ?`).bind(id).run(); return json({ ok: true }); }
    if (request.method === "PATCH") {
      const items = sanitiseItems(body.items);
      if (!items.length) return json({ error: "no items", reason: "A meal needs at least one food. Delete it instead." }, 400);
      const t = totalsOf(items);
      await env.DB.prepare(`UPDATE track_meals SET items_json = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?`).bind(JSON.stringify(items), t.kcal, t.protein_g, t.carbs_g, t.fat_g, id).run();
      return json({ ok: true, meal: await readMeal(env, id) });
    }
    return json({ error: "PATCH or DELETE" }, 405);
  }
  if (sub === "day" || sub === "week") {
    const target = String(url.searchParams.get("user") || me.id);
    if (target !== me.id && !(await canView(env, me.id, target))) return json({ error: "not allowed", reason: "You can only see days of people in your household." }, 403);
    const who = target === me.id ? me : await userById(env, target);
    if (!who) return json({ error: "no such user" }, 404);
    return json(sub === "day" ? await dayView(env, who, pickDate(url.searchParams.get("date")), { readOnly: target !== me.id }) : await weekView(env, who, pickDate(url.searchParams.get("end"))));
  }
  if (sub === "barcode") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await lookupBarcode(env, body.code);
    return json(out, out.ok ? 200 : 404);
  }
  if (sub === "weight") {
    if (request.method === "GET") return json(await listWeights(env, me.id, 30));
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await setWeight(env, me, body);
    if (out.ok && out.unit !== (me.targets?.unit || "kg")) await env.DB.prepare(`UPDATE track_users SET targets_json = ? WHERE id = ?`).bind(JSON.stringify({ ...(me.targets || {}), unit: out.unit }), me.id).run();
    return json(out.ok ? { ...out, trend: await listWeights(env, me.id, 30) } : out, out.ok ? 200 : 400);
  }
  if (sub === "household") {
    if (request.method === "GET") return json({ household: await householdView(env, me) });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const out = await createHousehold(env, me, body);
    return json(out.ok ? { ok: true, household: await householdView(env, me) } : out, out.ok ? 200 : 400);
  }
  if (sub === "household/join") { const out = await joinHousehold(env, me, body); return json(out.ok ? { ok: true, household: await householdView(env, me) } : out, out.ok ? 200 : 400); }
  if (sub === "household/leave") { return json(await leaveHousehold(env, me)); }
  if (sub === "receipts") { const h = await householdOf(env, me.id); return json(await listReceipts(env, { user: me, householdId: h?.id || null })); }
  if (sub.startsWith("receipt/") && request.method === "DELETE") {
    const h = await householdOf(env, me.id);
    const out = await deleteReceipt(env, { user: me, householdId: h?.id || null, id: sub.slice(8) });
    return json(out, out.ok ? 200 : out.status);
  }
  return json({ error: "not found" }, 404);
}

const PENDING_MESSAGE = "This email is already logging on another device. Sign in with Google to link devices, or ask your coach to link them.";

// --- JOIN: first device creates the log; a second device gets a code instead. ------
async function join(env, cfg, body, keyHash) {
  const email = cleanEmail(body.email);
  if (!email) return json({ error: "email", reason: "That doesn't look like an email address." }, 400);
  const existingDevice = await userForDevice(env, keyHash);
  if (existingDevice) return json({ linked: true, ...(await profile(env, existingDevice)) });   // reload of a known browser
  const userId = await sha256hex(`${email}\n${cfg.pepper}`);
  const user = await env.DB.prepare(`SELECT id FROM track_users WHERE id = ?`).bind(userId).first();
  const now = nowIso();
  if (!user) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO track_users (id, email, targets_json, created_at, last_seen) VALUES (?, ?, NULL, ?, ?)`).bind(userId, email, now, now),
      env.DB.prepare(`INSERT INTO track_devices (key_hash, user_id, label, created_at) VALUES (?, ?, 'first device', ?)`).bind(keyHash, userId, now),
    ]);
    console.log(JSON.stringify({ event: "foodlog-join", userId: userId.slice(0, 8) }));
    return json({ linked: true, ...(await profile(env, await userById(env, userId))), fresh: true });
  }
  // The email already has a log. This device is NOT let in; it gets a code the coach can link.
  await env.DB.prepare(`DELETE FROM track_pending WHERE created_at < ?`).bind(new Date(Date.now() - PENDING_TTL_MS).toISOString()).run();
  const prior = await env.DB.prepare(`SELECT code FROM track_pending WHERE key_hash = ?`).bind(keyHash).first();
  const code = prior?.code || randomCode(6);
  if (!prior) await env.DB.prepare(`INSERT INTO track_pending (code, key_hash, user_id_new, email, created_at) VALUES (?, ?, ?, ?, ?)`).bind(code, keyHash, randomId(8), email, now).run();
  return json({ linked: false, code, email, message: PENDING_MESSAGE, signIn: cfg.signIn.filter((s) => s.clientId).map((s) => s.provider) }, 202);
}

// --- SIGN IN: the provider's ID token proves the email; the device is linked. ------
async function signIn(env, cfg, body, keyHash, me) {
  const provider = String(body.provider || "").toLowerCase();
  const conf = cfg.signIn.find((s) => s.provider === provider && s.clientId);
  if (!conf) return json({ error: "provider not configured" }, 404);
  const v = await verifyIdToken(body.idToken, provider, { clientId: conf.clientId });
  if (!v.ok) { console.warn("foodlog signin refused", provider, v.reason); return json({ error: "refused", reason: `Sign-in refused: ${v.reason}.` }, 401); }
  const userId = await sha256hex(`${v.email}\n${cfg.pepper}`);
  if (me && me.id !== userId) return json({ error: "different email", reason: "This device is already linked to a different email." }, 409);
  const now = nowIso();
  const user = await env.DB.prepare(`SELECT id FROM track_users WHERE id = ?`).bind(userId).first();
  const ops = [];
  if (!user) ops.push(env.DB.prepare(`INSERT INTO track_users (id, email, targets_json, created_at, last_seen) VALUES (?, ?, NULL, ?, ?)`).bind(userId, v.email, now, now));
  if (!me) ops.push(env.DB.prepare(`INSERT INTO track_devices (key_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)`).bind(keyHash, userId, `signed in with ${provider}`, now));
  ops.push(env.DB.prepare(`DELETE FROM track_pending WHERE key_hash = ?`).bind(keyHash));
  await env.DB.batch(ops);
  return json({ linked: true, ...(await profile(env, await userById(env, userId))) });
}

// --- PHOTO: one call to the vision model, four kinds of picture. -----------------------
async function photo(request, env, cfg, me) {
  let form;
  try { form = await request.formData(); } catch { return json({ error: "bad request", reason: "Expected a multipart form with a photo." }, 400); }
  const f = form.get("photo");
  if (!f || typeof f.arrayBuffer !== "function") return json({ error: "no photo", reason: "No photo in the request." }, 400);
  if (f.size > cfg.maxPhotoBytes) return json({ error: "too big", reason: `That photo is ${(f.size / 1048576).toFixed(1)} MB; the limit is ${(cfg.maxPhotoBytes / 1048576).toFixed(0)} MB. The page should have shrunk it — reload and try again.` }, 413);
  const kind = ["food", "barcode", "label", "receipt"].includes(form.get("kind")) ? form.get("kind") : "food";
  const date = pickDate(form.get("date"));
  const correction = String(form.get("correction") || "").trim().slice(0, 200);
  const mealId = String(form.get("mealId") || "").trim();

  // The daily cap: every vision call counts, whatever kind.
  const used = (await env.DB.prepare(`SELECT photos FROM track_usage WHERE user_id = ? AND date = ?`).bind(me.id, todayUtc()).first())?.photos || 0;
  if (used >= cfg.dailyPhotoLimit) return json({ error: "daily-limit", reason: `That's ${cfg.dailyPhotoLimit} photos today — the daily limit. You can still type a meal.` }, 429);
  await env.DB.prepare(`INSERT INTO track_usage (user_id, date, photos) VALUES (?, ?, 1) ON CONFLICT(user_id, date) DO UPDATE SET photos = photos + 1`).bind(me.id, todayUtc()).run();

  const bytes = await f.arrayBuffer();
  const mime = /^image\/(png|webp)$/.test(f.type) ? f.type : "image/jpeg";
  const thumb = await cleanThumb(form.get("thumb"));

  let out;
  try {
    const prompt = kind === "food" ? PROMPTS.food(correction) : PROMPTS[kind];
    out = await runVision(env, cfg, { image: bytes, mime, prompt, maxTokens: kind === "receipt" ? 1500 : 900 });
  } catch (err) {
    console.error("foodlog vision failed", err?.message || err);
    return json({ error: "model", reason: "The model couldn't look at that just now. Try again, or type the meal." }, 502);
  }
  const parsed = extractJson(out.text);

  if (kind === "food") {
    const items = sanitiseItems(parsed?.items, { source: "photo" });
    if (!items.length) return json({ error: "no food", reason: parsed?.notes ? `I couldn't find food in that: ${String(parsed.notes).slice(0, 140)}` : "I couldn't make out any food in that photo. Try closer, with more light — or type it.", raw: out.text.slice(0, 300) }, 422);
    const meal = mealId ? await updateMealItems(env, me, mealId, items) : await insertMeal(env, me, { date, items, source: "photo", thumb });
    if (!meal) return json({ error: "no such meal" }, 404);
    return json({ ok: true, meal, notes: String(parsed?.notes || "").slice(0, 200), honesty: HONESTY });
  }
  if (kind === "barcode") {
    const digits = String(parsed?.digits || "").replace(/\D/g, "");
    const found = digits ? await lookupBarcode(env, digits) : { ok: false, reason: "I couldn't read a barcode in that photo. Get the numbers under the bars sharp, or snap the nutrition label." };
    return json({ ...found, digits }, found.ok ? 200 : 422);
  }
  if (kind === "label") {
    const label = sanitiseLabel(parsed);
    if (!label) return json({ error: "no label", reason: "I couldn't read a nutrition label in that photo. Fill the frame with the label and try again." }, 422);
    const stored = await rememberLabel(env, label);
    return json({ ok: true, label, product: stored.product, key: stored.key, previous: stored.previous ? { product: stored.previous, when: stored.previous.fetched_at } : null });
  }
  if (kind === "receipt") {
    const receipt = sanitiseReceipt(parsed);
    if (!receipt || !receipt.items.length) return json({ error: "no receipt", reason: "I couldn't read that as a receipt. Flatten it, fill the frame, and try again." }, 422);
    const h = await householdOf(env, me.id);
    return json({ ok: true, receipt: await saveReceipt(env, { user: me, householdId: h?.id || null, receipt, thumb }), shared: Boolean(h) });
  }
  return json({ error: "unknown kind" }, 400);
}

// The page sends a ≤256 px JPEG it made itself. We keep it only if it really is
// small — dimensions read from the header, bytes capped — else no thumbnail (fail open).
async function cleanThumb(t) {
  if (!t || typeof t.arrayBuffer !== "function" || t.size === 0 || t.size > THUMB_MAX_BYTES) return null;
  const bytes = await t.arrayBuffer();
  const size = imageSize(bytes);
  if (!size || size.w > THUMB_MAX_PX || size.h > THUMB_MAX_PX) return null;
  return `data:image/${size.type};base64,${toBase64(bytes)}`;
}

// --- TEXT: "2 eggs and toast" → the same JSON, no photo. --------------------------
async function textMeal(env, cfg, me, body) {
  const text = String(body.text || "").trim().slice(0, 300);
  if (!text) return json({ error: "empty", reason: "Type what you ate." }, 400);
  const correction = String(body.correction || "").trim().slice(0, 200);
  let out;
  try { out = await runVision(env, cfg, { prompt: PROMPTS.text(text, correction), maxTokens: 900 }); }
  catch (err) { console.error("foodlog text model failed", err?.message || err); return json({ error: "model", reason: "The model isn't answering just now. Try again in a minute." }, 502); }
  const parsed = extractJson(out.text);
  const items = sanitiseItems(parsed?.items, { source: "text" });
  if (!items.length) return json({ error: "no food", reason: "I couldn't turn that into foods. Try naming them plainly: '2 eggs, 1 slice of toast'." }, 422);
  const mealId = String(body.mealId || "").trim();
  const meal = mealId ? await updateMealItems(env, me, mealId, items) : await insertMeal(env, me, { date: pickDate(body.date), items, source: "text", thumb: null });
  if (!meal) return json({ error: "no such meal" }, 404);
  return json({ ok: true, meal, notes: String(parsed?.notes || "").slice(0, 200), honesty: HONESTY });
}

// --- A meal saved by hand (barcode / label / receipt items come through here). ----
async function saveMeal(env, me, body) {
  const items = sanitiseItems(body.items, { source: ["barcode", "label", "text", "photo", "receipt"].includes(body.source) ? body.source : "text" });
  if (!items.length) return json({ error: "no items", reason: "Nothing to save." }, 400);
  return json({ ok: true, meal: await insertMeal(env, me, { date: pickDate(body.date), items, source: items[0].source, thumb: null }) });
}

async function insertMeal(env, me, { date, items, source, thumb }) {
  const id = randomId(12), t = totalsOf(items), now = nowIso();
  await env.DB.prepare(`INSERT INTO track_meals (id, user_id, date, time, items_json, kcal, protein_g, carbs_g, fat_g, thumb, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, me.id, date, now.slice(11, 16), JSON.stringify(items), t.kcal, t.protein_g, t.carbs_g, t.fat_g, thumb, source, now).run();
  return readMeal(env, id);
}
async function updateMealItems(env, me, id, items) {
  const row = await env.DB.prepare(`SELECT user_id FROM track_meals WHERE id = ?`).bind(id).first();
  if (!row || row.user_id !== me.id) return null;
  const t = totalsOf(items);
  await env.DB.prepare(`UPDATE track_meals SET items_json = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?`).bind(JSON.stringify(items), t.kcal, t.protein_g, t.carbs_g, t.fat_g, id).run();
  return readMeal(env, id);
}
async function readMeal(env, id) {
  const r = await env.DB.prepare(`SELECT * FROM track_meals WHERE id = ?`).bind(id).first();
  return r ? mealOut(r) : null;
}
function mealOut(r) { let items = []; try { items = JSON.parse(r.items_json); } catch {} return { id: r.id, date: r.date, time: r.time, items, kcal: r.kcal, protein_g: r.protein_g, carbs_g: r.carbs_g, fat_g: r.fat_g, thumb: r.thumb, source: r.source, created_at: r.created_at }; }

// --- THE DAY and THE WEEK. -------------------------------------------------------------
async function dayView(env, who, date, { readOnly = false } = {}) {
  const rows = (await env.DB.prepare(`SELECT * FROM track_meals WHERE user_id = ? AND date = ? ORDER BY created_at`).bind(who.id, date).all()).results || [];
  const meals = rows.map(mealOut);
  const totals = totalsOf(meals);
  const weightRow = await env.DB.prepare(`SELECT kg FROM track_weights WHERE user_id = ? AND date = ?`).bind(who.id, date).first();
  return { date, targets: who.targets, totals, meals, weight: weightRow?.kg ?? null, weights: await listWeights(env, who.id, 30), readOnly, name: who.name || null, honesty: HONESTY };
}

async function weekView(env, who, end) {
  const start = addDays(end, -6);
  const rows = (await env.DB.prepare(`SELECT date, SUM(kcal) kcal, SUM(protein_g) protein_g, SUM(carbs_g) carbs_g, SUM(fat_g) fat_g, COUNT(*) meals FROM track_meals WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date`).bind(who.id, start, end).all()).results || [];
  const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
  const days = [];
  for (let i = 0; i < 7; i++) { const d = addDays(start, i); const r = byDate[d]; days.push({ date: d, kcal: Math.round(r?.kcal || 0), protein_g: round1(r?.protein_g || 0), carbs_g: round1(r?.carbs_g || 0), fat_g: round1(r?.fat_g || 0), meals: r?.meals || 0 }); }
  return { start, end, days, targets: who.targets, streak: await streakOf(env, who.id, end), adherence: adherenceOf(days, who.targets) };
}

// Streak: consecutive days with at least one meal, ending today or yesterday (today isn't over).
async function streakOf(env, userId, today) {
  const rows = (await env.DB.prepare(`SELECT DISTINCT date FROM track_meals WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 400`).bind(userId, today).all()).results || [];
  const have = new Set(rows.map((r) => r.date));
  let d = have.has(today) ? today : addDays(today, -1), n = 0;
  while (have.has(d)) { n++; d = addDays(d, -1); }
  return n;
}
// Adherence: of the logged days in the window, how many landed within ±15% of the calorie target.
function adherenceOf(days, targets) {
  const goal = Number(targets?.kcal) || 0;
  const logged = days.filter((d) => d.meals > 0);
  if (!goal || !logged.length) return null;
  const hit = logged.filter((d) => Math.abs(d.kcal - goal) / goal <= 0.15).length;
  return Math.round(100 * hit / logged.length);
}

// --- PEOPLE ---------------------------------------------------------------------------
async function userForDevice(env, keyHash) {
  const r = await env.DB.prepare(`SELECT u.* FROM track_devices d JOIN track_users u ON u.id = d.user_id WHERE d.key_hash = ?`).bind(keyHash).first();
  return r ? userOut(r) : null;
}
async function userById(env, id) { const r = await env.DB.prepare(`SELECT * FROM track_users WHERE id = ?`).bind(id).first(); return r ? userOut(r) : null; }
function userOut(r) { let targets = null; try { targets = r.targets_json ? JSON.parse(r.targets_json) : null; } catch {} return { id: r.id, email: r.email, targets, name: targets?.name || null, created_at: r.created_at, last_seen: r.last_seen }; }
function touch(env, me) { env.DB.prepare(`UPDATE track_users SET last_seen = ? WHERE id = ?`).bind(nowIso(), me.id).run().catch(() => {}); }
async function profile(env, me) {
  const devices = (await env.DB.prepare(`SELECT COUNT(*) n FROM track_devices WHERE user_id = ?`).bind(me.id).first())?.n || 1;
  return { userId: me.id, email: me.email, targets: me.targets, devices, household: await householdView(env, me) };
}
async function householdView(env, me) {
  const h = await householdOf(env, me.id);
  if (!h) return null;
  const members = [];
  for (const m of h.members) members.push({ ...m, weights: await listWeights(env, m.id, 30) });
  return { ...h, members };
}

function cleanTargets(t) {
  t = t && typeof t === "object" ? t : {};
  return {
    kcal: Math.round(clamp(t.kcal, 800, 8000, 2000)), protein_g: Math.round(clamp(t.protein_g, 0, 500, 150)),
    carbs_g: Math.round(clamp(t.carbs_g, 0, 1000, 200)), fat_g: Math.round(clamp(t.fat_g, 0, 400, 65)),
    unit: t.unit === "lb" ? "lb" : "kg", name: String(t.name || "").trim().slice(0, 40), preset: String(t.preset || "").slice(0, 12), weight_kg: round1(clamp(t.weight_kg, 0, 400, 0)) || null,
  };
}

// --- THE COACH (admin token). ------------------------------------------------------------
async function handleCoach(request, env, url, cfg) {
  const sub = url.pathname.slice("/api/admin/food/".length);
  if (sub === "clients") return json({ clients: await clientRows(env), coachName: cfg.coachName });
  if (sub.startsWith("client/")) {
    const who = await userById(env, sub.slice(7));
    if (!who) return json({ error: "no such client" }, 404);
    const end = todayUtc();
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(await dayView(env, who, addDays(end, -i)));
    const week = await weekView(env, who, end);
    const pending = (await env.DB.prepare(`SELECT code, created_at FROM track_pending WHERE email = ?`).bind(who.email).all()).results || [];
    const devices = (await env.DB.prepare(`SELECT label, created_at FROM track_devices WHERE user_id = ? ORDER BY created_at`).bind(who.id).all()).results || [];
    return json({ client: { ...who, household: await householdOf(env, who.id) }, days, week, pending, devices });
  }
  if (sub === "export.csv") return csv(await clientRows(env));
  if (sub === "link") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    const b = await readJson(request);
    const email = cleanEmail(b.email), code = String(b.deviceCode || b.code || "").trim().toUpperCase();
    const pend = await env.DB.prepare(`SELECT * FROM track_pending WHERE code = ?`).bind(code).first();
    if (!pend) return json({ error: "no such code", reason: "No device is waiting with that code. Codes expire after 7 days." }, 404);
    if (pend.email !== email) return json({ error: "email mismatch", reason: "That code was requested for a different email. Both must match — that's the point." }, 409);
    const user = await env.DB.prepare(`SELECT id FROM track_users WHERE email = ?`).bind(email).first();
    if (!user) return json({ error: "no such client" }, 404);
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO track_devices (key_hash, user_id, label, created_at) VALUES (?, ?, 'linked by coach', ?)`).bind(pend.key_hash, user.id, nowIso()),
      env.DB.prepare(`DELETE FROM track_pending WHERE code = ?`).bind(code),
    ]);
    return json({ ok: true, linked: true, userId: user.id });
  }
  return json({ error: "not found" }, 404);
}

async function clientRows(env) {
  const rows = (await env.DB.prepare(`SELECT u.id, u.email, u.targets_json, u.created_at, u.last_seen, (SELECT MAX(created_at) FROM track_meals m WHERE m.user_id = u.id) last_log, (SELECT COUNT(*) FROM track_devices d WHERE d.user_id = u.id) devices, (SELECT COUNT(*) FROM track_pending p WHERE p.email = u.email) pending, (SELECT h.name FROM track_members mb JOIN track_households h ON h.id = mb.household_id WHERE mb.user_id = u.id) household FROM track_users u ORDER BY last_log DESC`).all()).results || [];
  const out = [];
  for (const r of rows) {
    const who = userOut(r);
    const week = await weekView(env, who, todayUtc());
    const w = await listWeights(env, who.id, 30);
    out.push({ id: who.id, email: who.email, name: who.name, targets: who.targets, created_at: who.created_at, last_seen: who.last_seen, last_log: r.last_log, devices: r.devices, pending: r.pending, household: r.household, streak: week.streak, adherence: week.adherence, daysLogged: week.days.filter((d) => d.meals).length, avgKcal: Math.round(week.days.filter((d) => d.meals).reduce((a, d) => a + d.kcal, 0) / (week.days.filter((d) => d.meals).length || 1)), weight: w.latest, weightChange30: w.change });
  }
  return out;
}

function csv(rows) {
  const cols = ["email", "name", "kcal_target", "protein_target", "carbs_target", "fat_target", "streak", "adherence_pct", "days_logged_7d", "avg_kcal_7d", "weight_kg", "weight_change_30d", "household", "last_log", "created_at"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.join(",")].concat(rows.map((r) => [r.email, r.name, r.targets?.kcal, r.targets?.protein_g, r.targets?.carbs_g, r.targets?.fat_g, r.streak, r.adherence, r.daysLogged, r.avgKcal, r.weight, r.weightChange30, r.household, r.last_log, r.created_at].map(q).join(",")));
  return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="clients-${todayUtc()}.csv"` } });
}
