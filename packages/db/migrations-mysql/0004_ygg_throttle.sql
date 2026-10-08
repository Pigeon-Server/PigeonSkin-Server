-- MySQL 8.4 版迁移（自 packages/db/migrations/0004_ygg_throttle.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- MySQL 不支持 CREATE INDEX IF NOT EXISTS；执行器按迁移记账幂等推进，
-- 每个迁移只执行一次，直接写 CREATE INDEX。
CREATE INDEX auth_attempts_identifier_kind_created_idx ON auth_attempts(identifier, kind, created_at DESC);
