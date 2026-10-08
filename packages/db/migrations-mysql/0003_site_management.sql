-- MySQL 8.4 版迁移（自 packages/db/migrations/0003_site_management.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- IF NOT EXISTS 保留（MySQL 对 CREATE TABLE 支持 IF NOT EXISTS）。
CREATE TABLE IF NOT EXISTS translation_overrides (
  locale     VARCHAR(16)  NOT NULL,
  `key`        VARCHAR(512) NOT NULL,
  value      TEXT         NOT NULL,
  updated_at BIGINT       NOT NULL,
  PRIMARY KEY (locale, `key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS setup_guard (
  id         BIGINT PRIMARY KEY CHECK (id = 1),
  nonce      VARCHAR(128) NOT NULL,
  created_at BIGINT       NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
