-- MySQL 8.4 版迁移（自 packages/db/migrations/0014_official_catalog.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE textures ADD COLUMN official_key VARCHAR(512);
ALTER TABLE textures ADD COLUMN catalog_revision BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX textures_official_key_idx ON textures (official_key);
ALTER TABLE closet ADD COLUMN is_default BIGINT NOT NULL DEFAULT 0;

CREATE TABLE official_catalog_state (
  id       BIGINT PRIMARY KEY CHECK (id = 1),
  revision BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_default_catalog (
  user_id  BIGINT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT user_default_catalog_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
