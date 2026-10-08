-- PostgreSQL 版迁移（自 packages/db/migrations/0023_manual_content.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- SQLite 的 GLOB 'manual_document:*' → PG 等价写法 key LIKE 'manual_document:%'
--（GLOB 的 * 在 LIKE 中即 %，其余字符均非通配符，语义一致）。

CREATE TABLE manual_documents (
  slug TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (slug, locale)
);

CREATE INDEX manual_documents_locale_updated_idx ON manual_documents(locale, updated_at DESC);

INSERT INTO manual_documents (slug, locale, value, updated_at)
SELECT CASE substr(key, length('manual_document:') + 1)
         WHEN 'welcome' THEN ''
         ELSE substr(key, length('manual_document:') + 1)
       END,
       locale,
       value,
       updated_at
FROM settings
WHERE key LIKE 'manual_document:%';

CREATE TABLE manual_assets (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  uploaded_at BIGINT NOT NULL
);

INSERT INTO manual_assets (id, value, uploaded_at)
SELECT substr(key, length('manual_asset:') + 1), value, updated_at
FROM settings
WHERE key LIKE 'manual_asset:%' AND locale = '';

DELETE FROM settings WHERE key LIKE 'manual_document:%' OR key LIKE 'manual_asset:%';
