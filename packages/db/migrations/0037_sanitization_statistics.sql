INSERT INTO site_stats(metric,value) SELECT 'unsanitized_textures',COUNT(*) FROM textures WHERE sanitized=0;
CREATE TRIGGER texture_sanitized_stats_insert AFTER INSERT ON textures BEGIN
  UPDATE site_stats SET value=value+(CASE WHEN NEW.sanitized=0 THEN 1 ELSE 0 END) WHERE metric='unsanitized_textures' AND (CASE WHEN NEW.sanitized=0 THEN 1 ELSE 0 END)<>0;
END;
CREATE TRIGGER texture_sanitized_stats_delete AFTER DELETE ON textures BEGIN
  UPDATE site_stats SET value=value+(-(CASE WHEN OLD.sanitized=0 THEN 1 ELSE 0 END)) WHERE metric='unsanitized_textures' AND (-(CASE WHEN OLD.sanitized=0 THEN 1 ELSE 0 END))<>0;
END;
CREATE TRIGGER texture_sanitized_stats_update AFTER UPDATE OF sanitized ON textures BEGIN
  UPDATE site_stats SET value=value+((CASE WHEN NEW.sanitized=0 THEN 1 ELSE 0 END)-(CASE WHEN OLD.sanitized=0 THEN 1 ELSE 0 END)) WHERE metric='unsanitized_textures' AND ((CASE WHEN NEW.sanitized=0 THEN 1 ELSE 0 END)-(CASE WHEN OLD.sanitized=0 THEN 1 ELSE 0 END))<>0;
END;
