-- MySQL 8.4 版迁移（自 packages/db/migrations/0015_official_resource_sync.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

CREATE TABLE official_resource_sync (
  id             BIGINT PRIMARY KEY CHECK (id = 1),
  checked_at     BIGINT,
  succeeded_at   BIGINT,
  started_at     BIGINT,
  client_version VARCHAR(64) NOT NULL DEFAULT '1.21.4',
  added          BIGINT NOT NULL DEFAULT 0,
  updated        BIGINT NOT NULL DEFAULT 0,
  pending        BIGINT NOT NULL DEFAULT 0,
  error          TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO official_resource_sync (id) VALUES (1);
