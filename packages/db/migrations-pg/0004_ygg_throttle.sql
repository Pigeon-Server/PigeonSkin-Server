-- PostgreSQL 版迁移（自 packages/db/migrations/0004_ygg_throttle.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

CREATE INDEX IF NOT EXISTS auth_attempts_identifier_kind_created_idx ON auth_attempts(identifier, kind, created_at DESC);
