-- 性能改造收尾（PostgreSQL）：缓存版本触发器收窄、冗余索引清理。
-- 详见 sqlite 版 0041 的说明。

DROP TRIGGER IF EXISTS textures_cache_change ON textures;
DROP FUNCTION IF EXISTS refresh_textures_cache_version();
CREATE FUNCTION refresh_textures_cache_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- 只有这些列变化才影响公开目录的展示；likes/updated_at/净化标记等不再失效缓存
  IF TG_OP = 'UPDATE' AND
     NEW.visibility IS NOT DISTINCT FROM OLD.visibility AND
     NEW.kind IS NOT DISTINCT FROM OLD.kind AND
     NEW.model IS NOT DISTINCT FROM OLD.model AND
     NEW.name IS NOT DISTINCT FROM OLD.name AND
     NEW.uploader_id IS NOT DISTINCT FROM OLD.uploader_id AND
     NEW.hash IS NOT DISTINCT FROM OLD.hash AND
     NEW.official_key IS NOT DISTINCT FROM OLD.official_key AND
     NEW.width IS NOT DISTINCT FROM OLD.width AND
     NEW.height IS NOT DISTINCT FROM OLD.height AND
     NEW.size_bytes IS NOT DISTINCT FROM OLD.size_bytes AND
     NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NULL;
  END IF;
  UPDATE public_cache_versions SET version=version+1 WHERE scope='textures';
  RETURN NULL;
END; $$;
CREATE TRIGGER textures_cache_change AFTER INSERT OR UPDATE OR DELETE ON textures FOR EACH STATEMENT EXECUTE FUNCTION refresh_textures_cache_version();

DROP INDEX IF EXISTS textures_vis_created_idx;
DROP INDEX IF EXISTS textures_vis_likes_idx;
DROP INDEX IF EXISTS textures_hash_idx;
