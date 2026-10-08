-- PostgreSQL 版迁移（自 packages/db/migrations/0005_ygg_log_owners.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE ygg_log ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ygg_log ADD COLUMN player_id BIGINT REFERENCES players(id) ON DELETE SET NULL;
