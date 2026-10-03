CREATE TABLE IF NOT EXISTS translation_overrides (
  locale TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (locale, key)
);

CREATE TABLE IF NOT EXISTS setup_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
