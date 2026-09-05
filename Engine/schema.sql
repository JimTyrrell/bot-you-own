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
