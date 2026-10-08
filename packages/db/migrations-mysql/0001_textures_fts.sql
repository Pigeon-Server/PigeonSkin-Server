-- MySQL 8.4 版迁移（自 packages/db/migrations/0001_textures_fts.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- 纹理全文搜索索引
--
-- SQLite 原版使用 FTS5（trigram 分词器）实现子串匹配搜索。MySQL 版等价实现：
--   • 建 textures_fts 镜像表，name 列上建 FULLTEXT 索引并使用 ngram 分词器，
--     ngram 原生支持 CJK 子串匹配语义（与 trigram 的子串匹配对齐）。
--   • 搜索由运行时 `textContains`（packages/db/src/dialect.ts）方言实现生成
--     MATCH(name) AGAINST('"*q*"' IN BOOLEAN MODE)（ngram 布尔模式），
--     行为与原 trigram 子串匹配对齐。
--   • 同步触发器改写为 MySQL 触发器语法（插入/删除/改名三个）。
--   • 迁移执行器按"整脚本 exec"应用，不支持 DELIMITER 切换；触发器体
--     均单语句化：update 触发器用 REPLACE INTO 把删除+插入合并。

CREATE TABLE textures_fts (
  rowid BIGINT PRIMARY KEY,
  name  TEXT,
  FULLTEXT KEY ft_name (name) WITH PARSER ngram
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 外部内容表的 FTS 镜像需要手动同步。三个触发器覆盖插入/删除/改名。
CREATE TRIGGER textures_fts_insert AFTER INSERT ON textures FOR EACH ROW
  INSERT INTO textures_fts(rowid, name) VALUES (new.id, new.name);

CREATE TRIGGER textures_fts_delete AFTER DELETE ON textures FOR EACH ROW
  DELETE FROM textures_fts WHERE rowid = old.id;

CREATE TRIGGER textures_fts_update AFTER UPDATE ON textures FOR EACH ROW
  REPLACE INTO textures_fts(rowid, name) SELECT new.id, new.name WHERE new.name <=> old.name = 0;
