-- MySQL 8.4 版迁移（自 packages/db/migrations/0010_product_name.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

UPDATE settings
SET value = CASE
  WHEN value = 'Blessing Skin (dev)' THEN 'Pigeon Skin Server (dev)'
  ELSE 'Pigeon Skin Server'
END,
updated_at = (UNIX_TIMESTAMP() * 1000)
WHERE settings.`key` = 'site_name'
  AND value IN ('Blessing Skin', 'Blessing Skin Server', 'Blessing Skin (dev)');

UPDATE translation_overrides
SET value = CASE
  WHEN translation_overrides.`key` = 'common.powered_by' THEN 'Powered by Pigeon Skin Server'
  ELSE 'Pigeon Skin Server'
END,
updated_at = (UNIX_TIMESTAMP() * 1000)
WHERE (translation_overrides.`key` IN ('home.title', 'common.product_name') AND value IN ('Blessing Skin', 'Blessing Skin Server'))
  OR (translation_overrides.`key` = 'common.powered_by' AND value = 'Powered by Blessing Skin');
