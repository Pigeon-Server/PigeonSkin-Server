CREATE TABLE ai_runtime_state (
  provider VARCHAR(32) PRIMARY KEY,
  paused_until BIGINT NOT NULL DEFAULT 0,
  revision BIGINT NOT NULL DEFAULT 0,
  config_fingerprint VARCHAR(64) NOT NULL DEFAULT ''
);
INSERT INTO ai_runtime_state(provider) VALUES ('workers');
CREATE INDEX ai_jobs_kind_status_due_idx ON ai_jobs(kind,status,next_run_at,id);
CREATE FUNCTION reset_workers_ai_quota() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF (NEW."key" LIKE 'ai%' OR NEW."key" LIKE 'texture_ai%' OR NEW."key" LIKE 'notification_ai%' OR NEW."key"='comments_ai_moderation' OR NEW."key"='openai_base_url') THEN
      UPDATE ai_runtime_state SET paused_until=0,revision=revision+1,config_fingerprint='' WHERE provider='workers';
    END IF;
  ELSIF TG_OP='DELETE' THEN
    IF (OLD."key" LIKE 'ai%' OR OLD."key" LIKE 'texture_ai%' OR OLD."key" LIKE 'notification_ai%' OR OLD."key"='comments_ai_moderation' OR OLD."key"='openai_base_url') THEN
      UPDATE ai_runtime_state SET paused_until=0,revision=revision+1,config_fingerprint='' WHERE provider='workers';
    END IF;
  ELSE
    IF ((NEW."key" LIKE 'ai%' OR NEW."key" LIKE 'texture_ai%' OR NEW."key" LIKE 'notification_ai%' OR NEW."key"='comments_ai_moderation' OR NEW."key"='openai_base_url') OR (OLD."key" LIKE 'ai%' OR OLD."key" LIKE 'texture_ai%' OR OLD."key" LIKE 'notification_ai%' OR OLD."key"='comments_ai_moderation' OR OLD."key"='openai_base_url')) AND (NEW.value<>OLD.value OR NEW."key"<>OLD."key" OR NEW.locale<>OLD.locale) THEN
      UPDATE ai_runtime_state SET paused_until=0,revision=revision+1,config_fingerprint='' WHERE provider='workers';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_settings_reset AFTER INSERT OR UPDATE OR DELETE ON settings FOR EACH ROW EXECUTE FUNCTION reset_workers_ai_quota();
