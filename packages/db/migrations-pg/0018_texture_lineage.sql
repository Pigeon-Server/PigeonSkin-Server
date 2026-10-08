-- PostgreSQL 版迁移（自 packages/db/migrations/0018_texture_lineage.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE textures ADD COLUMN source_resource_id BIGINT REFERENCES textures(id) ON DELETE SET NULL;
CREATE INDEX textures_source_resource ON textures(source_resource_id);
