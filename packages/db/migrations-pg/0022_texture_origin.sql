-- PostgreSQL 版迁移（自 packages/db/migrations/0022_texture_origin.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE textures ADD COLUMN origin TEXT NOT NULL DEFAULT 'original' CHECK (origin IN ('original', 'repost'));
UPDATE textures SET origin = 'repost' WHERE official_key IS NOT NULL;
