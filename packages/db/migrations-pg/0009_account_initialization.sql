-- PostgreSQL 版迁移（自 packages/db/migrations/0009_account_initialization.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE users ADD COLUMN needs_initialization BIGINT NOT NULL DEFAULT 0;
UPDATE users SET needs_initialization = 1
WHERE password_hash = '' OR email = '' OR email LIKE '%@oauth.invalid' OR email LIKE '%@oauth.local';
