INSERT INTO public_cache_versions(scope,version) VALUES('discovery',1);
CREATE TRIGGER connect_clients_cache_insert AFTER INSERT ON connect_clients BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='discovery';
END;
CREATE TRIGGER connect_clients_cache_update AFTER UPDATE ON connect_clients BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='discovery';
END;
CREATE TRIGGER connect_clients_cache_delete AFTER DELETE ON connect_clients BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='discovery';
END;
CREATE TRIGGER connect_keys_cache_insert AFTER INSERT ON connect_keys BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='discovery';
END;
CREATE TRIGGER connect_keys_cache_update AFTER UPDATE ON connect_keys BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='discovery';
END;
CREATE TRIGGER connect_keys_cache_delete AFTER DELETE ON connect_keys BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='discovery';
END;
