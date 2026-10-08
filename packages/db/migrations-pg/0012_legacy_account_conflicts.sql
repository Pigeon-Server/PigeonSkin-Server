-- PostgreSQL 版迁移（自 packages/db/migrations/0012_legacy_account_conflicts.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE users ADD COLUMN legacy_email_conflict BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN merged_into_user_id BIGINT REFERENCES users(id);
DROP INDEX users_email_unique;
-- COLLATE NOCASE → lower(email) 函数唯一索引；部分索引原生支持
CREATE UNIQUE INDEX users_email_unique ON users(lower(email)) WHERE legacy_email_conflict = 0;

CREATE TABLE legacy_account_merges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  retained_user_id BIGINT NOT NULL REFERENCES users(id),
  merged_user_ids TEXT NOT NULL,
  archived_data TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX legacy_account_merges_email_nocase_unique ON legacy_account_merges(lower(email));
