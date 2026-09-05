-- Optional audit log. See docs/CUSTOMIZE.md → "Read what your bot has been saying".
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project    TEXT,
  visitor    TEXT,           -- email in email mode, 'admin', or empty
  asked      TEXT,
  answered   TEXT,
  refused    INTEGER DEFAULT 0,
  flags      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_conv_refused ON conversations(refused);

-- Existing table from an earlier version? Add the column:
-- ALTER TABLE conversations ADD COLUMN visitor TEXT;

-- What the document scan did (Configure → Documents; under the hood → Files).
-- One row per outcome. Created by the Worker on first use, like the table above.
CREATE TABLE IF NOT EXISTS library_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot        TEXT,               -- which bot's library
  file       TEXT,               -- the document's name
  event      TEXT NOT NULL,      -- held | override | upload | remove | rescan-held
  detail     TEXT,               -- for held / rescan-held: JSON of what was found (labels, counts, masked samples)
  who        TEXT,               -- 'admin' (Configure) or 'github' (the sync action)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_libev_bot ON library_events(bot, id);

-- Leads: one row per visitor email, with the stored AI summary (Engine/worker/leads.js).
-- The Worker creates this itself on first use; kept here for reading.
CREATE TABLE IF NOT EXISTS leads (
  visitor          TEXT PRIMARY KEY,   -- the email they gave (email mode); never "admin"
  bot              TEXT,               -- the bot of their latest turn when summarised
  summary          TEXT,               -- JSON: asked[], situation, cares_about[], objections[], next_step, score, reason
  score            INTEGER,            -- 0-100
  updated_at       TEXT NOT NULL,
  turns_at_summary INTEGER DEFAULT 0,  -- how many turns the summary covered (more since = stale)
  sent_at          TEXT                -- last time it was pushed to the webhook
);
CREATE INDEX IF NOT EXISTS idx_conv_visitor ON conversations(visitor, id);

-- Gaps: what the bot couldn't answer, as a to-do list (Engine/worker/gaps.js; under the hood → Audit).
-- One row per bot per normalised question. Counts are refreshed from conversations on
-- every read; state and draft are yours and are never overwritten by the refresh.
CREATE TABLE IF NOT EXISTS gaps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bot          TEXT NOT NULL,      -- the bot's id (YourBots/<id>)
  question_key TEXT NOT NULL,      -- the question, lowercased, punctuation stripped
  question     TEXT,               -- the newest wording a visitor used
  count_seen   INTEGER DEFAULT 0,  -- how many times it was refused in the window
  last_seen    TEXT,
  state        TEXT NOT NULL DEFAULT 'open',   -- open | drafted | accepted | dismissed
  draft        TEXT,               -- the FAQ entry (model draft, then whatever you accepted)
  grounded     INTEGER,            -- 1 = the files held the answer; 0 = template with blanks
  missing      TEXT,               -- JSON list of what the files didn't say
  file         TEXT,               -- the knowledge file it was added to
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gaps_bot_key ON gaps(bot, question_key);
-- Talk to a person (Engine/worker/person.js). One row per request; the thread lives
-- in handoff_messages. The id is 48 random hex characters and is the visitor's key.
-- The Worker creates these itself on first use; kept here for reading.
CREATE TABLE IF NOT EXISTS handoffs (
  id         TEXT PRIMARY KEY,   -- 48 hex chars; stored with the visitor's chat, sent in the webhook link
  bot        TEXT,               -- the bot's id (folder name)
  chat_id    TEXT,               -- the page's chat id; one open request per chat
  visitor    TEXT,               -- the email they gave at the door (email mode), 'admin', or empty
  transcript TEXT,               -- JSON: the last 8 turns before the button, redacted like conversations
  status     TEXT NOT NULL DEFAULT 'open',   -- open (waiting on you) | answered (waiting on them) | closed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_chat ON handoffs(bot, chat_id, status);
CREATE TABLE IF NOT EXISTS handoff_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,   -- the page polls with ?since=<id>
  handoff_id TEXT NOT NULL,
  from_role  TEXT NOT NULL,      -- visitor | owner
  text       TEXT NOT NULL,      -- NOT redacted: "call me on …" is the point of the thread
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hmsg_handoff ON handoff_messages(handoff_id, id);

-- The food log (Engine/worker/track.js; docs/FOOD-LOG.md). Created by the Worker on first use.
CREATE TABLE IF NOT EXISTS track_users (
  id           TEXT PRIMARY KEY,   -- sha256(lowercased email + FOODLOG_PEPPER)
  email        TEXT UNIQUE,        -- the identity; the only personal thing stored
  targets_json TEXT,               -- {kcal, protein_g, carbs_g, fat_g, unit, name, preset, weight_kg}
  created_at   TEXT NOT NULL,
  last_seen    TEXT
);
CREATE TABLE IF NOT EXISTS track_devices (
  key_hash   TEXT PRIMARY KEY,     -- sha256 of the browser's random device key; the key itself never leaves the browser
  user_id    TEXT NOT NULL,
  label      TEXT,                 -- 'first device' | 'linked by coach' | 'signed in with google' …
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_devices_user ON track_devices(user_id);
CREATE TABLE IF NOT EXISTS track_pending (
  code        TEXT PRIMARY KEY,    -- the 6-character code a second device shows
  key_hash    TEXT NOT NULL,       -- that device's key hash, linked when the coach approves
  user_id_new TEXT,
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL        -- codes expire after 7 days
);
CREATE TABLE IF NOT EXISTS track_meals (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,        -- YYYY-MM-DD, the phone's own day
  time       TEXT,                 -- HH:MM UTC
  items_json TEXT NOT NULL,        -- [{name, portion, grams, kcal, protein_g, carbs_g, fat_g, confidence, source, mult, per100?}]
  kcal REAL, protein_g REAL, carbs_g REAL, fat_g REAL,
  thumb      TEXT,                 -- data: URI, ≤256 px, ≤48 KB. The photo itself is never kept
  source     TEXT,                 -- photo | text | barcode | label | receipt
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_meals_day ON track_meals(user_id, date);
CREATE TABLE IF NOT EXISTS track_usage (user_id TEXT NOT NULL, date TEXT NOT NULL, photos INTEGER DEFAULT 0, PRIMARY KEY (user_id, date));   -- the daily photo cap
CREATE TABLE IF NOT EXISTS track_products (code TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL);   -- barcode lookups (Open Food Facts) and read labels ("label:<slug>")
CREATE TABLE IF NOT EXISTS track_receipts (
  id TEXT PRIMARY KEY, household_id TEXT, user_id TEXT NOT NULL,   -- household_id set = shared with the household
  store TEXT, date TEXT, total REAL, currency TEXT, items_json TEXT, thumb TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_receipts_h ON track_receipts(household_id, date);
CREATE TABLE IF NOT EXISTS track_weights (user_id TEXT NOT NULL, date TEXT NOT NULL, kg REAL NOT NULL, PRIMARY KEY (user_id, date));   -- always kg; the unit is the person's choice on the page
CREATE TABLE IF NOT EXISTS track_households (id TEXT PRIMARY KEY, name TEXT, code TEXT UNIQUE, created_at TEXT NOT NULL);   -- code = the 6-character invite
CREATE TABLE IF NOT EXISTS track_members (household_id TEXT NOT NULL, user_id TEXT PRIMARY KEY, name TEXT, joined_at TEXT NOT NULL);   -- one household per person
CREATE INDEX IF NOT EXISTS idx_track_members_h ON track_members(household_id);
