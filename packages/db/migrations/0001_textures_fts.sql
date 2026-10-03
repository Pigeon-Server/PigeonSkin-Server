-- 纹理全文搜索索引（FTS5）
--
-- D1 支持 FTS5（含 fts5vocab），所以搜索用它而不是 `name LIKE '%q%'`
-- —— 后者用不上索引，在几十万行的表上就是全表扫描。
--
-- 分词器选 `trigram` 而不是默认的 `unicode61`，有两个具体原因：
--   1. 旧版搜索就是子串匹配（LIKE '%keyword%'），用户期待这个行为
--   2. `unicode61` 不做 CJK 分词，中文纹理名会变成一个不透明的整串 token，
--      只有整串精确匹配才可能命中 —— 而中文是一等支持的语言
-- `trigram` 的代价是索引更大（约被索引文本的 3 倍），且查询至少 3 个字符
-- （更短的查询在应用层回退为精确匹配，见 src/…/textures 查询）。

CREATE VIRTUAL TABLE textures_fts USING fts5(
  name,
  content = 'textures',
  content_rowid = 'id',
  tokenize = 'trigram'
);

-- 外部内容表的 FTS5 需要手动同步。三个触发器覆盖插入/删除/改名。
CREATE TRIGGER textures_fts_insert AFTER INSERT ON textures BEGIN
  INSERT INTO textures_fts(rowid, name) VALUES (new.id, new.name);
END;

CREATE TRIGGER textures_fts_delete AFTER DELETE ON textures BEGIN
  INSERT INTO textures_fts(textures_fts, rowid, name) VALUES ('delete', old.id, old.name);
END;

CREATE TRIGGER textures_fts_update AFTER UPDATE OF name ON textures BEGIN
  INSERT INTO textures_fts(textures_fts, rowid, name) VALUES ('delete', old.id, old.name);
  INSERT INTO textures_fts(rowid, name) VALUES (new.id, new.name);
END;
