INSERT INTO public_cache_versions(scope,version) VALUES('discovery',1);
CREATE FUNCTION refresh_discovery_cache_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public_cache_versions SET version=version+1 WHERE scope='discovery'; RETURN NULL; END; $$;
CREATE TRIGGER connect_clients_cache_change AFTER INSERT OR UPDATE OR DELETE ON connect_clients FOR EACH STATEMENT EXECUTE FUNCTION refresh_discovery_cache_version();
CREATE TRIGGER connect_keys_cache_change AFTER INSERT OR UPDATE OR DELETE ON connect_keys FOR EACH STATEMENT EXECUTE FUNCTION refresh_discovery_cache_version();
