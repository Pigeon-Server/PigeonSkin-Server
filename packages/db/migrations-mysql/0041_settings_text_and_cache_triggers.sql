-- 性能改造收尾（MySQL）：缓存版本触发器收窄、冗余索引清理、大文本列扩容。
-- 详见 sqlite 版 0041 的说明。

DROP TRIGGER IF EXISTS textures_cache_update;
-- MySQL 触发器是逐行的，条件放在 WHEN 之外（MySQL 触发器不支持 WHEN）；
-- 用 IF 比较新旧值，只有影响展示的列变化才 bump。
CREATE TRIGGER textures_cache_update AFTER UPDATE ON textures FOR EACH ROW
  UPDATE public_cache_versions SET version=version+1 WHERE scope='textures'
    AND (NOT (NEW.visibility <=> OLD.visibility) OR NOT (NEW.kind <=> OLD.kind)
      OR NOT (NEW.model <=> OLD.model) OR NOT (NEW.name <=> OLD.name)
      OR NOT (NEW.uploader_id <=> OLD.uploader_id) OR NOT (NEW.hash <=> OLD.hash)
      OR NOT (NEW.official_key <=> OLD.official_key) OR NOT (NEW.width <=> OLD.width)
      OR NOT (NEW.height <=> OLD.height) OR NOT (NEW.size_bytes <=> OLD.size_bytes)
      OR NOT (NEW.created_at <=> OLD.created_at));

DROP INDEX IF EXISTS textures_vis_created_idx ON textures;
DROP INDEX IF EXISTS textures_vis_likes_idx ON textures;
DROP INDEX IF EXISTS textures_hash_idx ON textures;

-- 快照与设置值是多条长文本的聚合，TEXT 的 64 KiB 上限会导致设置保存失败
ALTER TABLE settings_snapshots MODIFY value MEDIUMTEXT NOT NULL;
ALTER TABLE settings MODIFY value MEDIUMTEXT NOT NULL;
