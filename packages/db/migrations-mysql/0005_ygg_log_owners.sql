-- MySQL 8.4 版迁移（自 packages/db/migrations/0005_ygg_log_owners.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- SQLite 的列级 REFERENCES 改为 MySQL 表级 FOREIGN KEY 语法。
ALTER TABLE ygg_log ADD COLUMN user_id BIGINT, ADD CONSTRAINT ygg_log_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ygg_log ADD COLUMN player_id BIGINT, ADD CONSTRAINT ygg_log_player_fk FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL;
