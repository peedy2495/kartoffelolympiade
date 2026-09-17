-- Kartoffelolympiade schema (idempotent; no destructive migrations).
-- All tables prefixed ko_ to avoid collisions.

CREATE TABLE IF NOT EXISTS ko_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO ko_settings (key, value) VALUES ('collection_open', '0');

CREATE TABLE IF NOT EXISTS ko_supervisors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ko_participants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  age_group TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS ko_results (
  participant_id TEXT NOT NULL,
  discipline TEXT NOT NULL,
  value INTEGER NOT NULL,
  supervisor_id TEXT,
  supervisor_name TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, discipline),
  FOREIGN KEY (participant_id) REFERENCES ko_participants(id) ON DELETE CASCADE
);
