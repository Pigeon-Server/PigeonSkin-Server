CREATE TABLE manual_documents (
  slug TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
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
WHERE key GLOB 'manual_document:*';

CREATE TABLE manual_assets (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);

INSERT INTO manual_assets (id, value, uploaded_at)
SELECT substr(key, length('manual_asset:') + 1), value, updated_at
FROM settings
WHERE key GLOB 'manual_asset:*' AND locale = '';

DELETE FROM settings WHERE key GLOB 'manual_document:*' OR key GLOB 'manual_asset:*';
