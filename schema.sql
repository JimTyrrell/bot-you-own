-- Optional audit log. See CUSTOMIZE.md → "Read what your bot has been saying".
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
