-- MySQL 8.4 版迁移（自 packages/db/migrations/0013_email_uniqueness.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- SQLite 原版用两个触发器强制 email 大小写不敏感唯一（legacy 冲突账号豁免）。
-- MySQL 版在 0012 已用生成列 email_unique_slot（conflict=0 时取 email，否则 NULL）
-- 上的唯一索引实现了同一语义：ai_ci 排序规则保证大小写不敏感，NULL 豁免冲突账号。
-- 触发器因此冗余，本迁移保留文件序号仅作说明，无语句。
SELECT 1;
