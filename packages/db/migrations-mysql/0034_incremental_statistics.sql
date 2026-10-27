CREATE TABLE site_stats(metric VARCHAR(64) PRIMARY KEY,value BIGINT NOT NULL DEFAULT 0);
CREATE TRIGGER users_stats_children_delete BEFORE DELETE ON users FOR EACH ROW BEGIN
DELETE FROM players WHERE user_id=OLD.id;
DELETE FROM reports WHERE reporter_id=OLD.id;
UPDATE textures SET uploader_id=NULL WHERE uploader_id=OLD.id;
END;
CREATE TRIGGER textures_stats_children_delete BEFORE DELETE ON textures FOR EACH ROW
DELETE FROM reports WHERE texture_id=OLD.id;
CREATE TABLE daily_stats(metric VARCHAR(32) NOT NULL,day BIGINT NOT NULL,value BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(metric,day));
CREATE TABLE texture_counts(scope VARCHAR(64) NOT NULL,kind VARCHAR(16) NOT NULL,model VARCHAR(16) NOT NULL,official INTEGER NOT NULL,value BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(scope,kind,model,official));
INSERT INTO site_stats(metric,value) SELECT 'users',COUNT(*) FROM users UNION ALL SELECT 'players',COUNT(*) FROM players UNION ALL SELECT 'textures',COUNT(*) FROM textures UNION ALL SELECT 'pending_reports',COUNT(*) FROM reports WHERE status='pending' UNION ALL SELECT 'texture_bytes',COALESCE(SUM(size_bytes),0) FROM textures;
INSERT INTO daily_stats(metric,day,value) SELECT 'registrations',FLOOR((created_at)/86400000)*86400000,COUNT(*) FROM users GROUP BY FLOOR((created_at)/86400000)*86400000;
INSERT INTO daily_stats(metric,day,value) SELECT 'uploads',FLOOR((created_at)/86400000)*86400000,COUNT(*) FROM textures GROUP BY FLOOR((created_at)/86400000)*86400000;
INSERT INTO texture_counts(scope,kind,model,official,value) SELECT CONCAT('p:',visibility),kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END,COUNT(*) FROM textures GROUP BY CONCAT('p:',visibility),kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END;
INSERT INTO texture_counts(scope,kind,model,official,value) SELECT CONCAT('u:',COALESCE(uploader_id,0),':',visibility),kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END,COUNT(*) FROM textures GROUP BY CONCAT('u:',COALESCE(uploader_id,0),':',visibility),kind,COALESCE(model,''),CASE WHEN official_key IS NULL THEN 0 ELSE 1 END;
CREATE TRIGGER users_stats_insert AFTER INSERT ON users FOR EACH ROW BEGIN
UPDATE site_stats SET value=value+(1) WHERE metric='users';
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',FLOOR((NEW.created_at)/86400000)*86400000,1) ON DUPLICATE KEY UPDATE value=daily_stats.value+VALUES(value);
END;
CREATE TRIGGER users_stats_delete AFTER DELETE ON users FOR EACH ROW BEGIN
UPDATE site_stats SET value=value+(-1) WHERE metric='users';
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',FLOOR((OLD.created_at)/86400000)*86400000,-1) ON DUPLICATE KEY UPDATE value=daily_stats.value+VALUES(value);
END;
CREATE TRIGGER users_stats_update AFTER UPDATE ON users FOR EACH ROW BEGIN
IF NOT (NEW.created_at <=> OLD.created_at) THEN
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',FLOOR((OLD.created_at)/86400000)*86400000,-1) ON DUPLICATE KEY UPDATE value=daily_stats.value+VALUES(value);
INSERT INTO daily_stats(metric,day,value) VALUES('registrations',FLOOR((NEW.created_at)/86400000)*86400000,1) ON DUPLICATE KEY UPDATE value=daily_stats.value+VALUES(value);
END IF;
END;
CREATE TRIGGER players_stats_insert AFTER INSERT ON players FOR EACH ROW BEGIN
UPDATE site_stats SET value=value+(1) WHERE metric='players';
END;
CREATE TRIGGER players_stats_delete AFTER DELETE ON players FOR EACH ROW BEGIN
UPDATE site_stats SET value=value+(-1) WHERE metric='players';
END;
CREATE TRIGGER textures_stats_insert AFTER INSERT ON textures FOR EACH ROW BEGIN
UPDATE site_stats SET value=value+(1) WHERE metric='textures';
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',FLOOR((NEW.created_at)/86400000)*86400000,1) ON DUPLICATE KEY UPDATE value=daily_stats.value+VALUES(value);
UPDATE site_stats SET value=value+(1)*NEW.size_bytes WHERE metric='texture_bytes';
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES(CONCAT('p:',NEW.visibility),NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON DUPLICATE KEY UPDATE value=texture_counts.value+VALUES(value);
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES(CONCAT('u:',COALESCE(NEW.uploader_id,0),':',NEW.visibility),NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON DUPLICATE KEY UPDATE value=texture_counts.value+VALUES(value);
END;
CREATE TRIGGER textures_stats_delete AFTER DELETE ON textures FOR EACH ROW BEGIN
UPDATE site_stats SET value=value+(-1) WHERE metric='textures';
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',FLOOR((OLD.created_at)/86400000)*86400000,-1) ON DUPLICATE KEY UPDATE value=daily_stats.value+VALUES(value);
UPDATE site_stats SET value=value+(-1)*OLD.size_bytes WHERE metric='texture_bytes';
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES(CONCAT('p:',OLD.visibility),OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON DUPLICATE KEY UPDATE value=texture_counts.value+VALUES(value);
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES(CONCAT('u:',COALESCE(OLD.uploader_id,0),':',OLD.visibility),OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON DUPLICATE KEY UPDATE value=texture_counts.value+VALUES(value);
END;
CREATE TRIGGER textures_stats_update AFTER UPDATE ON textures FOR EACH ROW BEGIN
IF NOT (NEW.size_bytes <=> OLD.size_bytes) OR NOT (NEW.created_at <=> OLD.created_at) THEN
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',FLOOR((OLD.created_at)/86400000)*86400000,-1) ON DUPLICATE KEY UPDATE value=daily_stats.value+VALUES(value);
INSERT INTO daily_stats(metric,day,value) VALUES('uploads',FLOOR((NEW.created_at)/86400000)*86400000,1) ON DUPLICATE KEY UPDATE value=daily_stats.value+VALUES(value);
UPDATE site_stats SET value=value+NEW.size_bytes-OLD.size_bytes WHERE metric='texture_bytes';
END IF;
END;
CREATE TRIGGER textures_counts_update AFTER UPDATE ON textures FOR EACH ROW BEGIN
IF NOT (NEW.visibility <=> OLD.visibility) OR NOT (NEW.uploader_id <=> OLD.uploader_id) OR NOT (NEW.kind <=> OLD.kind) OR NOT (NEW.model <=> OLD.model) OR NOT (NEW.official_key <=> OLD.official_key) THEN
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES(CONCAT('p:',OLD.visibility),OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON DUPLICATE KEY UPDATE value=texture_counts.value+VALUES(value);
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES(CONCAT('u:',COALESCE(OLD.uploader_id,0),':',OLD.visibility),OLD.kind,COALESCE(OLD.model,''),CASE WHEN OLD.official_key IS NULL THEN 0 ELSE 1 END,-1) ON DUPLICATE KEY UPDATE value=texture_counts.value+VALUES(value);
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES(CONCAT('p:',NEW.visibility),NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON DUPLICATE KEY UPDATE value=texture_counts.value+VALUES(value);
INSERT INTO texture_counts(scope,kind,model,official,value) VALUES(CONCAT('u:',COALESCE(NEW.uploader_id,0),':',NEW.visibility),NEW.kind,COALESCE(NEW.model,''),CASE WHEN NEW.official_key IS NULL THEN 0 ELSE 1 END,1) ON DUPLICATE KEY UPDATE value=texture_counts.value+VALUES(value);
END IF;
END;
CREATE TRIGGER reports_stats_insert AFTER INSERT ON reports FOR EACH ROW BEGIN
UPDATE site_stats SET value=value+(CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END) WHERE metric='pending_reports' AND (CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)<>0;
END;
CREATE TRIGGER reports_stats_delete AFTER DELETE ON reports FOR EACH ROW BEGIN
UPDATE site_stats SET value=value+(-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END)) WHERE metric='pending_reports' AND (-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END))<>0;
END;
CREATE TRIGGER reports_stats_update AFTER UPDATE ON reports FOR EACH ROW BEGIN
IF NOT (NEW.status <=> OLD.status) THEN
UPDATE site_stats SET value=value+((CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END)) WHERE metric='pending_reports' AND ((CASE WHEN NEW.status='pending' THEN 1 ELSE 0 END)-(CASE WHEN OLD.status='pending' THEN 1 ELSE 0 END))<>0;
END IF;
END;
