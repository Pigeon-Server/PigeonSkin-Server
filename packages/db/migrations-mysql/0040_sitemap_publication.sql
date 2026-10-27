INSERT INTO public_cache_versions(scope,version) VALUES ('sitemap',1);
CREATE TRIGGER sitemap_texture_insert AFTER INSERT ON textures FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap' AND NEW.visibility='public';
CREATE TRIGGER sitemap_texture_delete AFTER DELETE ON textures FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap' AND OLD.visibility='public';
CREATE TRIGGER sitemap_texture_update AFTER UPDATE ON textures FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap' AND (NEW.visibility<>OLD.visibility OR NEW.updated_at<>OLD.updated_at) AND (NEW.visibility='public' OR OLD.visibility='public');
CREATE INDEX textures_sitemap_idx ON textures(visibility,updated_at DESC,id DESC);
