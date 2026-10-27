CREATE TABLE ai_runtime_state (
  provider VARCHAR(32) PRIMARY KEY,
  paused_until BIGINT NOT NULL DEFAULT 0,
  revision BIGINT NOT NULL DEFAULT 0,
  config_fingerprint VARCHAR(64) NOT NULL DEFAULT ''
);
INSERT INTO ai_runtime_state(provider) VALUES ('workers');
CREATE INDEX ai_jobs_kind_status_due_idx ON ai_jobs(kind,status,next_run_at,id);
CREATE TRIGGER ai_settings_reset_insert AFTER INSERT ON settings WHEN (NEW."key" LIKE 'ai%' OR NEW."key" LIKE 'texture_ai%' OR NEW."key" LIKE 'notification_ai%' OR NEW."key"='comments_ai_moderation' OR NEW."key"='openai_base_url') BEGIN
  UPDATE ai_runtime_state SET paused_until=0,revision=revision+1,config_fingerprint='' WHERE provider='workers';
END;
CREATE TRIGGER ai_settings_reset_update AFTER UPDATE ON settings WHEN ((NEW."key" LIKE 'ai%' OR NEW."key" LIKE 'texture_ai%' OR NEW."key" LIKE 'notification_ai%' OR NEW."key"='comments_ai_moderation' OR NEW."key"='openai_base_url') OR (OLD."key" LIKE 'ai%' OR OLD."key" LIKE 'texture_ai%' OR OLD."key" LIKE 'notification_ai%' OR OLD."key"='comments_ai_moderation' OR OLD."key"='openai_base_url')) AND (NEW.value<>OLD.value OR NEW."key"<>OLD."key" OR NEW.locale<>OLD.locale) BEGIN
  UPDATE ai_runtime_state SET paused_until=0,revision=revision+1,config_fingerprint='' WHERE provider='workers';
END;
CREATE TRIGGER ai_settings_reset_delete AFTER DELETE ON settings WHEN (OLD."key" LIKE 'ai%' OR OLD."key" LIKE 'texture_ai%' OR OLD."key" LIKE 'notification_ai%' OR OLD."key"='comments_ai_moderation' OR OLD."key"='openai_base_url') BEGIN
  UPDATE ai_runtime_state SET paused_until=0,revision=revision+1,config_fingerprint='' WHERE provider='workers';
END;
