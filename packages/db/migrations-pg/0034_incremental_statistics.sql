CREATE TABLE site_stats(metric TEXT PRIMARY KEY,value BIGINT NOT NULL DEFAULT 0);
CREATE TABLE daily_stats(metric TEXT NOT NULL,day BIGINT NOT NULL,value BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(metric,day));
CREATE TABLE texture_counts(scope TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,official INTEGER NOT NULL,value BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(scope,kind,model,official));
INSERT INTO site_stats(metric,value) SELECT 'users',COUNT(*) FROM users UNION ALL SELECT 'players',COUNT(*) FROM players UNION ALL SELECT 'textures',COUNT(*) FROM textures UNION ALL SELECT 'pending_reports',COUNT(*) FROM reports WHERE status='pending' UNION ALL SELECT 'texture_bytes',COALESCE(SUM(size_bytes),0) FROM textures;
INSERT INTO daily_stats(metric,day,value) SELECT 'registrations',(floor((created_at)::numeric/86400000)*86400000)::bigint,COUNT(*) FROM users GROUP BY (floor((created_at)::numeric/86400000)*86400000)::bigint;
INSERT INTO daily_stats(metric,day,value) SELECT 'uploads',(floor((created_at)::numeric/86400000)*86400000)::bigint,COUNT(*) FROM textures GROUP BY (floor((created_at)::numeric/86400000)*86400000)::bigint;
INSERT INTO texture_counts(scope,kind,model,official,value) SELECT 'p:'||visibility,kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END,COUNT(*) FROM textures GROUP BY 'p:'||visibility,kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END;
INSERT INTO texture_counts(scope,kind,model,official,value) SELECT 'u:'||COALESCE(uploader_id,0)||':'||visibility,kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END,COUNT(*) FROM textures GROUP BY 'u:'||COALESCE(uploader_id,0)||':'||visibility,kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END;
CREATE FUNCTION users_stats_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE site_stats SET value=value+(1) WHERE metric='users';
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',(floor((NEW.created_at)::numeric/86400000)*86400000)::bigint,1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
RETURN NULL;
END; $$;
CREATE TRIGGER users_stats_insert AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION users_stats_insert_fn();
CREATE FUNCTION users_stats_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE site_stats SET value=value+(-1) WHERE metric='users';
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',(floor((OLD.created_at)::numeric/86400000)*86400000)::bigint,-1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
RETURN NULL;
END; $$;
CREATE TRIGGER users_stats_delete AFTER DELETE ON users FOR EACH ROW EXECUTE FUNCTION users_stats_delete_fn();
CREATE FUNCTION users_stats_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',(floor((OLD.created_at)::numeric/86400000)*86400000)::bigint,-1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',(floor((NEW.created_at)::numeric/86400000)*86400000)::bigint,1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
RETURN NULL;
END; $$;
CREATE TRIGGER users_stats_update AFTER UPDATE OF created_at ON users FOR EACH ROW EXECUTE FUNCTION users_stats_update_fn();
CREATE FUNCTION players_stats_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE site_stats SET value=value+(1) WHERE metric='players';
RETURN NULL;
END; $$;
CREATE TRIGGER players_stats_insert AFTER INSERT ON players FOR EACH ROW EXECUTE FUNCTION players_stats_insert_fn();
CREATE FUNCTION players_stats_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE site_stats SET value=value+(-1) WHERE metric='players';
RETURN NULL;
END; $$;
CREATE TRIGGER players_stats_delete AFTER DELETE ON players FOR EACH ROW EXECUTE FUNCTION players_stats_delete_fn();
CREATE FUNCTION textures_stats_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE site_stats SET value=value+(1) WHERE metric='textures';
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',(floor((NEW.created_at)::numeric/86400000)*86400000)::bigint,1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
UPDATE site_stats SET value=value+(1)*NEW.size_bytes WHERE metric='texture_bytes';
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('p:'||NEW.visibility,NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('u:'||COALESCE(NEW.uploader_id,0)||':'||NEW.visibility,NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
RETURN NULL;
END; $$;
CREATE TRIGGER textures_stats_insert AFTER INSERT ON textures FOR EACH ROW EXECUTE FUNCTION textures_stats_insert_fn();
CREATE FUNCTION textures_stats_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE site_stats SET value=value+(-1) WHERE metric='textures';
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',(floor((OLD.created_at)::numeric/86400000)*86400000)::bigint,-1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
UPDATE site_stats SET value=value+(-1)*OLD.size_bytes WHERE metric='texture_bytes';
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('p:'||OLD.visibility,OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('u:'||COALESCE(OLD.uploader_id,0)||':'||OLD.visibility,OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
RETURN NULL;
END; $$;
CREATE TRIGGER textures_stats_delete AFTER DELETE ON textures FOR EACH ROW EXECUTE FUNCTION textures_stats_delete_fn();
CREATE FUNCTION textures_stats_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',(floor((OLD.created_at)::numeric/86400000)*86400000)::bigint,-1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',(floor((NEW.created_at)::numeric/86400000)*86400000)::bigint,1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
UPDATE site_stats SET value=value+NEW.size_bytes-OLD.size_bytes WHERE metric='texture_bytes';
RETURN NULL;
END; $$;
CREATE TRIGGER textures_stats_update AFTER UPDATE OF size_bytes,created_at ON textures FOR EACH ROW EXECUTE FUNCTION textures_stats_update_fn();
CREATE FUNCTION textures_counts_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('p:'||OLD.visibility,OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('u:'||COALESCE(OLD.uploader_id,0)||':'||OLD.visibility,OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('p:'||NEW.visibility,NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('u:'||COALESCE(NEW.uploader_id,0)||':'||NEW.visibility,NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
RETURN NULL;
END; $$;
CREATE TRIGGER textures_counts_update AFTER UPDATE OF visibility,uploader_id,kind,model,official_key ON textures FOR EACH ROW EXECUTE FUNCTION textures_counts_update_fn();
CREATE FUNCTION reports_stats_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE site_stats SET value=value+(CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END) WHERE metric='pending_reports' AND (CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)<>0;
RETURN NULL;
END; $$;
CREATE TRIGGER reports_stats_insert AFTER INSERT ON reports FOR EACH ROW EXECUTE FUNCTION reports_stats_insert_fn();
CREATE FUNCTION reports_stats_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE site_stats SET value=value+(-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END)) WHERE metric='pending_reports' AND (-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END))<>0;
RETURN NULL;
END; $$;
CREATE TRIGGER reports_stats_delete AFTER DELETE ON reports FOR EACH ROW EXECUTE FUNCTION reports_stats_delete_fn();
CREATE FUNCTION reports_stats_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE site_stats SET value=value+((CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END)) WHERE metric='pending_reports' AND ((CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END))<>0;
RETURN NULL;
END; $$;
CREATE TRIGGER reports_stats_update AFTER UPDATE OF status ON reports FOR EACH ROW EXECUTE FUNCTION reports_stats_update_fn();
