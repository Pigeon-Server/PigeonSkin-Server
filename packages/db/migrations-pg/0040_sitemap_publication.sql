INSERT INTO public_cache_versions(scope,version) VALUES ('sitemap',1);
CREATE FUNCTION sitemap_texture_version() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.visibility='public' THEN UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap'; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.visibility='public' THEN UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap'; END IF;
  ELSE
    IF (NEW.visibility<>OLD.visibility OR NEW.updated_at<>OLD.updated_at) AND (NEW.visibility='public' OR OLD.visibility='public') THEN UPDATE public_cache_versions SET version=version+1 WHERE scope='sitemap'; END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sitemap_texture_version AFTER INSERT OR UPDATE OR DELETE ON textures FOR EACH ROW EXECUTE FUNCTION sitemap_texture_version();
CREATE INDEX textures_sitemap_idx ON textures(visibility,updated_at DESC,id DESC);
