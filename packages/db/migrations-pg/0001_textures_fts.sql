-- PostgreSQL 版迁移（自 packages/db/migrations/0001_textures_fts.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- 纹理名称搜索索引（SQLite 版为 FTS5 trigram，PG 用 pg_trgm 等价实现）
--
-- D1 版用 FTS5（trigram 分词）支持子串搜索；PG 侧等价方案是 pg_trgm 的
-- GIN trigram 索引：`name ILIKE '%q%'` 可直接走该索引，语义同样是子串匹配
-- （旧版搜索行为，且中文纹理名可命中）。
--
-- 搜索查询由运行时 `textContains`（packages/db/src/dialect.ts）方言实现生成（name ILIKE '%q%' 走该索引）；
-- 短于 3 个字符的查询在应用层回退为精确匹配（trigram 索引无法服务过短查询）。
-- trigram 索引由 PG 在列数据变更时自动维护，不需要 SQLite 版的三个同步触发器。
-- 不建 textures_fts 表或任何 content 表。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX textures_name_trgm ON textures USING GIN (name gin_trgm_ops);
