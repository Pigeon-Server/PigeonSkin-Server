INSERT INTO public_cache_versions(scope,version) VALUES ('sitemap',1);
CREATE TRIGGER sitemap_texture_insert AFTER INSERT ON textures WHEN NEW.visibility='public' BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap';
END;
CREATE TRIGGER sitemap_texture_delete AFTER DELETE ON textures WHEN OLD.visibility='public' BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap';
END;
CREATE TRIGGER sitemap_texture_update AFTER UPDATE OF visibility,updated_at ON textures WHEN (NEW.visibility<>OLD.visibility OR NEW.updated_at<>OLD.updated_at) AND (NEW.visibility='public' OR OLD.visibility='public') BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap';
END;
CREATE INDEX textures_sitemap_idx ON textures(visibility,updated_at DESC,id DESC);
