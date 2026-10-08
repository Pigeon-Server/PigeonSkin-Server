-- PostgreSQL 版迁移（自 packages/db/migrations/0014_official_catalog.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE textures ADD COLUMN official_key TEXT;
ALTER TABLE textures ADD COLUMN catalog_revision BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX textures_official_key_idx ON textures (official_key);

ALTER TABLE closet ADD COLUMN is_default BIGINT NOT NULL DEFAULT 0;

CREATE TABLE official_catalog_state (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  revision BIGINT NOT NULL
);

CREATE TABLE user_default_catalog (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 0
);
