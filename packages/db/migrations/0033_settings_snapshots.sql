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
INSERT INTO settings_snapshots(locale,value,updated_at) SELECT locale,json_group_object(key,value),MAX(updated_at) FROM settings GROUP BY locale;
CREATE TRIGGER settings_snapshot_insert AFTER INSERT ON settings BEGIN
  INSERT INTO settings_snapshots(locale,value,updated_at) VALUES(NEW.locale,json_object(NEW.key,NEW.value),NEW.updated_at)
  ON CONFLICT(locale) DO UPDATE SET value=json_patch(settings_snapshots.value,excluded.value),revision=settings_snapshots.revision+1,updated_at=excluded.updated_at;
  UPDATE public_cache_versions SET version=version+1 WHERE scope='settings';
END;
CREATE TRIGGER settings_snapshot_update AFTER UPDATE ON settings BEGIN
  UPDATE settings_snapshots SET value=json_remove(value,'$.'||json_quote(OLD.key)),revision=revision+1 WHERE locale=OLD.locale;
  INSERT INTO settings_snapshots(locale,value,updated_at) VALUES(NEW.locale,json_object(NEW.key,NEW.value),NEW.updated_at)
  ON CONFLICT(locale) DO UPDATE SET value=json_patch(settings_snapshots.value,excluded.value),revision=settings_snapshots.revision+1,updated_at=excluded.updated_at;
  UPDATE public_cache_versions SET version=version+1 WHERE scope='settings';
END;
CREATE TRIGGER settings_snapshot_delete AFTER DELETE ON settings BEGIN
  UPDATE settings_snapshots SET value=json_remove(value,'$.'||json_quote(OLD.key)),revision=revision+1,updated_at=OLD.updated_at WHERE locale=OLD.locale;
  UPDATE public_cache_versions SET version=version+1 WHERE scope='settings';
END;
CREATE TRIGGER manual_cache_insert AFTER INSERT ON manual_documents BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='manual';
END;
CREATE TRIGGER manual_cache_update AFTER UPDATE ON manual_documents BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='manual';
END;
CREATE TRIGGER manual_cache_delete AFTER DELETE ON manual_documents BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='manual';
END;
CREATE TRIGGER translations_cache_insert AFTER INSERT ON translation_overrides BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='translations';
END;
CREATE TRIGGER translations_cache_update AFTER UPDATE ON translation_overrides BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='translations';
END;
CREATE TRIGGER translations_cache_delete AFTER DELETE ON translation_overrides BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='translations';
END;
CREATE TRIGGER textures_cache_insert AFTER INSERT ON textures BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='textures';
END;
CREATE TRIGGER textures_cache_update AFTER UPDATE ON textures BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='textures';
END;
CREATE TRIGGER textures_cache_delete AFTER DELETE ON textures BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='textures';
END;
CREATE TABLE settings_write_locks(scope VARCHAR(32) PRIMARY KEY,token VARCHAR(64));
INSERT INTO settings_write_locks(scope) VALUES ('settings');
