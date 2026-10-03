CREATE TABLE official_resource_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at INTEGER,
  succeeded_at INTEGER,
  started_at INTEGER,
  client_version TEXT NOT NULL DEFAULT '1.21.4',
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
INSERT INTO official_resource_sync (id) VALUES (1);
