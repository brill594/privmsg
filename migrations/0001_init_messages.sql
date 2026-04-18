CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  total_size INTEGER NOT NULL DEFAULT 0,
  max_reads INTEGER NOT NULL DEFAULT 1,
  read_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  burned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages (expires_at);
