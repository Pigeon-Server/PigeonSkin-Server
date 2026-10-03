ALTER TABLE textures ADD COLUMN official_key TEXT;
ALTER TABLE textures ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX textures_official_key_idx ON textures (official_key);
ALTER TABLE closet ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
CREATE TABLE official_catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);
CREATE TABLE user_default_catalog (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0
);
