CREATE TABLE site_stats(metric TEXT PRIMARY KEY,value BIGINT NOT NULL DEFAULT 0);
CREATE TABLE daily_stats(metric TEXT NOT NULL,day BIGINT NOT NULL,value BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(metric,day));
CREATE TABLE texture_counts(scope TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,official INTEGER NOT NULL,value BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(scope,kind,model,official));
INSERT INTO site_stats(metric,value) SELECT 'users',COUNT(*) FROM users UNION ALL SELECT 'players',COUNT(*) FROM players UNION ALL SELECT 'textures',COUNT(*) FROM textures UNION ALL SELECT 'pending_reports',COUNT(*) FROM reports WHERE status='pending' UNION ALL SELECT 'texture_bytes',COALESCE(SUM(size_bytes),0) FROM textures;
INSERT INTO daily_stats(metric,day,value) SELECT 'registrations',CAST((created_at)/86400000 AS INTEGER)*86400000,COUNT(*) FROM users GROUP BY CAST((created_at)/86400000 AS INTEGER)*86400000;
INSERT INTO daily_stats(metric,day,value) SELECT 'uploads',CAST((created_at)/86400000 AS INTEGER)*86400000,COUNT(*) FROM textures GROUP BY CAST((created_at)/86400000 AS INTEGER)*86400000;
INSERT INTO texture_counts(scope,kind,model,official,value) SELECT 'p:'||visibility,kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END,COUNT(*) FROM textures GROUP BY 'p:'||visibility,kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END;
INSERT INTO texture_counts(scope,kind,model,official,value) SELECT 'u:'||COALESCE(uploader_id,0)||':'||visibility,kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END,COUNT(*) FROM textures GROUP BY 'u:'||COALESCE(uploader_id,0)||':'||visibility,kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END;
CREATE TRIGGER users_stats_insert AFTER INSERT ON users BEGIN
UPDATE site_stats SET value=value+(1) WHERE metric='users';
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',CAST((NEW.created_at)/86400000 AS INTEGER)*86400000,1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
END;
CREATE TRIGGER users_stats_delete AFTER DELETE ON users BEGIN
UPDATE site_stats SET value=value+(-1) WHERE metric='users';
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',CAST((OLD.created_at)/86400000 AS INTEGER)*86400000,-1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
END;
CREATE TRIGGER users_stats_update AFTER UPDATE OF created_at ON users BEGIN
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',CAST((OLD.created_at)/86400000 AS INTEGER)*86400000,-1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',CAST((NEW.created_at)/86400000 AS INTEGER)*86400000,1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
END;
CREATE TRIGGER players_stats_insert AFTER INSERT ON players BEGIN
UPDATE site_stats SET value=value+(1) WHERE metric='players';
END;
CREATE TRIGGER players_stats_delete AFTER DELETE ON players BEGIN
UPDATE site_stats SET value=value+(-1) WHERE metric='players';
END;
CREATE TRIGGER textures_stats_insert AFTER INSERT ON textures BEGIN
UPDATE site_stats SET value=value+(1) WHERE metric='textures';
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',CAST((NEW.created_at)/86400000 AS INTEGER)*86400000,1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
UPDATE site_stats SET value=value+(1)*NEW.size_bytes WHERE metric='texture_bytes';
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('p:'||NEW.visibility,NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('u:'||COALESCE(NEW.uploader_id,0)||':'||NEW.visibility,NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
END;
CREATE TRIGGER textures_stats_delete AFTER DELETE ON textures BEGIN
UPDATE site_stats SET value=value+(-1) WHERE metric='textures';
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',CAST((OLD.created_at)/86400000 AS INTEGER)*86400000,-1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
UPDATE site_stats SET value=value+(-1)*OLD.size_bytes WHERE metric='texture_bytes';
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('p:'||OLD.visibility,OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('u:'||COALESCE(OLD.uploader_id,0)||':'||OLD.visibility,OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
END;
CREATE TRIGGER textures_stats_update AFTER UPDATE OF size_bytes,created_at ON textures BEGIN
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',CAST((OLD.created_at)/86400000 AS INTEGER)*86400000,-1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',CAST((NEW.created_at)/86400000 AS INTEGER)*86400000,1) ON CONFLICT(metric,day) DO UPDATE SET value=daily_stats.value+excluded.value;
UPDATE site_stats SET value=value+NEW.size_bytes-OLD.size_bytes WHERE metric='texture_bytes';
END;
CREATE TRIGGER textures_counts_update AFTER UPDATE OF visibility,uploader_id,kind,model,official_key ON textures BEGIN
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('p:'||OLD.visibility,OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('u:'||COALESCE(OLD.uploader_id,0)||':'||OLD.visibility,OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('p:'||NEW.visibility,NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES('u:'||COALESCE(NEW.uploader_id,0)||':'||NEW.visibility,NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON CONFLICT(scope,kind,model,official) DO UPDATE SET value=texture_counts.value+excluded.value;
END;
CREATE TRIGGER reports_stats_insert AFTER INSERT ON reports BEGIN
UPDATE site_stats SET value=value+(CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END) WHERE metric='pending_reports' AND (CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)<>0;
END;
CREATE TRIGGER reports_stats_delete AFTER DELETE ON reports BEGIN
UPDATE site_stats SET value=value+(-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END)) WHERE metric='pending_reports' AND (-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END))<>0;
END;
CREATE TRIGGER reports_stats_update AFTER UPDATE OF status ON reports BEGIN
UPDATE site_stats SET value=value+((CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END)) WHERE metric='pending_reports' AND ((CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END))<>0;
END;
