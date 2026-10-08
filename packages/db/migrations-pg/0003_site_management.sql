-- PostgreSQL 版迁移（自 packages/db/migrations/0003_site_management.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

CREATE TABLE IF NOT EXISTS translation_overrides (
  locale TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (locale, key)
);

CREATE TABLE IF NOT EXISTS setup_guard (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  nonce TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
