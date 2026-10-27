CREATE TABLE settings_snapshots (
  locale VARCHAR(32) PRIMARY KEY,
  value TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL
);
CREATE TABLE public_cache_versions (
  scope VARCHAR(32) PRIMARY KEY,
  version BIGINT NOT NULL DEFAULT 1
);
INSERT INTO public_cache_versions(scope,version) VALUES ('settings',1),('manual',1),('translations',1),('textures',1);
INSERT INTO settings_snapshots(locale,value,updated_at) SELECT locale,JSON_OBJECTAGG(`key`,value),MAX(updated_at) FROM settings GROUP BY locale;
CREATE TRIGGER settings_snapshot_insert AFTER INSERT ON settings FOR EACH ROW BEGIN
  INSERT INTO settings_snapshots(locale,value,updated_at) VALUES(NEW.locale,JSON_OBJECT(NEW.`key`,NEW.value),NEW.updated_at) ON DUPLICATE KEY UPDATE value=JSON_MERGE_PATCH(settings_snapshots.value,JSON_OBJECT(NEW.`key`,NEW.value)),revision=revision+1,updated_at=NEW.updated_at;
  UPDATE public_cache_versions SET version=version+1 WHERE scope='settings';
END;
CREATE TRIGGER settings_snapshot_update AFTER UPDATE ON settings FOR EACH ROW BEGIN
  UPDATE settings_snapshots SET value=JSON_REMOVE(value,CONCAT('$.',JSON_QUOTE(OLD.`key`))),revision=revision+1 WHERE locale=OLD.locale;
  INSERT INTO settings_snapshots(locale,value,updated_at) VALUES(NEW.locale,JSON_OBJECT(NEW.`key`,NEW.value),NEW.updated_at) ON DUPLICATE KEY UPDATE value=JSON_MERGE_PATCH(settings_snapshots.value,JSON_OBJECT(NEW.`key`,NEW.value)),revision=revision+1,updated_at=NEW.updated_at;
  UPDATE public_cache_versions SET version=version+1 WHERE scope='settings';
END;
CREATE TRIGGER settings_snapshot_delete AFTER DELETE ON settings FOR EACH ROW BEGIN
  UPDATE settings_snapshots SET value=JSON_REMOVE(value,CONCAT('$.',JSON_QUOTE(OLD.`key`))),revision=revision+1 WHERE locale=OLD.locale;
  UPDATE public_cache_versions SET version=version+1 WHERE scope='settings';
END;
CREATE TRIGGER manual_cache_insert AFTER INSERT ON manual_documents FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='manual';
CREATE TRIGGER manual_cache_update AFTER UPDATE ON manual_documents FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='manual';
CREATE TRIGGER manual_cache_delete AFTER DELETE ON manual_documents FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='manual';
CREATE TRIGGER translations_cache_insert AFTER INSERT ON translation_overrides FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='translations';
CREATE TRIGGER translations_cache_update AFTER UPDATE ON translation_overrides FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='translations';
CREATE TRIGGER translations_cache_delete AFTER DELETE ON translation_overrides FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='translations';
CREATE TRIGGER textures_cache_insert AFTER INSERT ON textures FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='textures';
CREATE TRIGGER textures_cache_update AFTER UPDATE ON textures FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='textures';
CREATE TRIGGER textures_cache_delete AFTER DELETE ON textures FOR EACH ROW UPDATE public_cache_versions SET version=version+1 WHERE scope='textures';
CREATE TABLE settings_write_locks(scope VARCHAR(32) PRIMARY KEY,token VARCHAR(64));
INSERT INTO settings_write_locks(scope) VALUES ('settings');
