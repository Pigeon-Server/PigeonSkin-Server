CREATE TABLE settings_snapshots (
  locale TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL
);
CREATE TABLE public_cache_versions (
  scope TEXT PRIMARY KEY,
  version BIGINT NOT NULL DEFAULT 1
);
INSERT INTO public_cache_versions(scope,version) VALUES ('settings',1),('manual',1),('translations',1),('textures',1);
INSERT INTO settings_snapshots(locale,value,updated_at) SELECT locale,jsonb_object_agg(key,value)::text,MAX(updated_at) FROM settings GROUP BY locale;
CREATE FUNCTION refresh_settings_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_OP='UPDATE' THEN
    UPDATE settings_snapshots SET value=(value::jsonb-OLD.key)::text,revision=revision+1 WHERE locale=OLD.locale;
  END IF;
  IF TG_OP<>'DELETE' THEN
    INSERT INTO settings_snapshots(locale,value,updated_at) VALUES(NEW.locale,jsonb_build_object(NEW.key,NEW.value)::text,NEW.updated_at)
    ON CONFLICT(locale) DO UPDATE SET value=(settings_snapshots.value::jsonb||excluded.value::jsonb)::text,revision=settings_snapshots.revision+1,updated_at=excluded.updated_at;
  END IF;
  UPDATE public_cache_versions SET version=version+1 WHERE scope='settings';
  RETURN NULL;
END;
$$;
CREATE TRIGGER settings_snapshot_change AFTER INSERT OR UPDATE OR DELETE ON settings FOR EACH ROW EXECUTE FUNCTION refresh_settings_snapshot();
CREATE FUNCTION refresh_manual_cache_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public_cache_versions SET version=version+1 WHERE scope='manual'; RETURN NULL; END; $$;
CREATE TRIGGER manual_cache_change AFTER INSERT OR UPDATE OR DELETE ON manual_documents FOR EACH STATEMENT EXECUTE FUNCTION refresh_manual_cache_version();
CREATE FUNCTION refresh_translations_cache_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public_cache_versions SET version=version+1 WHERE scope='translations'; RETURN NULL; END; $$;
CREATE TRIGGER translations_cache_change AFTER INSERT OR UPDATE OR DELETE ON translation_overrides FOR EACH STATEMENT EXECUTE FUNCTION refresh_translations_cache_version();
CREATE FUNCTION refresh_textures_cache_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public_cache_versions SET version=version+1 WHERE scope='textures'; RETURN NULL; END; $$;
CREATE TRIGGER textures_cache_change AFTER INSERT OR UPDATE OR DELETE ON textures FOR EACH STATEMENT EXECUTE FUNCTION refresh_textures_cache_version();
CREATE TABLE settings_write_locks(scope VARCHAR(32) PRIMARY KEY,token VARCHAR(64));
INSERT INTO settings_write_locks(scope) VALUES ('settings');
