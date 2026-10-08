-- MySQL 8.4 版迁移（自 packages/db/migrations/0023_manual_content.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- 方言差异说明：SQLite 的 GLOB 'xxx:*' 改为 MySQL 等价的 LIKE 'xxx/%'——
-- '_' 与 '%' 是 LIKE 通配符，slug 中可能出现下划线，故用 ESCAPE 转义基准前缀
-- 中的字面 'manual_document:' 与 'manual_asset:'。此处前缀无通配符字符，
-- 直接 LIKE 'manual_document:%' 即可（前缀中的 ':' 不是通配符）。

CREATE TABLE manual_documents (
  slug       VARCHAR(512) NOT NULL,
  locale     VARCHAR(16) NOT NULL DEFAULT '',
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (slug, locale)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX manual_documents_locale_updated_idx ON manual_documents(locale, updated_at DESC);

INSERT INTO manual_documents (slug, locale, value, updated_at)
SELECT CASE SUBSTRING(settings.`key`, CHAR_LENGTH('manual_document:') + 1)
         WHEN 'welcome' THEN ''
         ELSE SUBSTRING(settings.`key`, CHAR_LENGTH('manual_document:') + 1)
       END,
       locale,
       value,
       updated_at
FROM settings
WHERE settings.`key` LIKE 'manual_document:%';

CREATE TABLE manual_assets (
  id          VARCHAR(512) PRIMARY KEY,
  value       TEXT NOT NULL,
  uploaded_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO manual_assets (id, value, uploaded_at)
SELECT SUBSTRING(settings.`key`, CHAR_LENGTH('manual_asset:') + 1), value, updated_at
FROM settings
WHERE settings.`key` LIKE 'manual_asset:%' AND locale = '';

DELETE FROM settings WHERE settings.`key` LIKE 'manual_document:%' OR settings.`key` LIKE 'manual_asset:%';
