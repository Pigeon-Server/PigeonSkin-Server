UPDATE settings
SET value = CASE
  WHEN value = 'Blessing Skin (dev)' THEN 'Pigeon Skin Server (dev)'
  ELSE 'Pigeon Skin Server'
END,
updated_at = strftime('%s', 'now') * 1000
WHERE key = 'site_name'
  AND value IN ('Blessing Skin', 'Blessing Skin Server', 'Blessing Skin (dev)');

UPDATE translation_overrides
SET value = CASE
  WHEN key = 'common.powered_by' THEN 'Powered by Pigeon Skin Server'
  ELSE 'Pigeon Skin Server'
END,
updated_at = strftime('%s', 'now') * 1000
WHERE (key IN ('home.title', 'common.product_name') AND value IN ('Blessing Skin', 'Blessing Skin Server'))
  OR (key = 'common.powered_by' AND value = 'Powered by Blessing Skin');
