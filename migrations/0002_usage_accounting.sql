ALTER TABLE messages ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN objects_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN storage_projection_month TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_messages_usage_projection
  ON messages (objects_deleted, expires_at, storage_projection_month);

CREATE TABLE IF NOT EXISTS usage_counters (
  scope TEXT NOT NULL,
  period_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, period_key, metric)
);

CREATE TABLE IF NOT EXISTS usage_state (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
