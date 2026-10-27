CREATE TABLE notification_counts(user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,unread BIGINT NOT NULL DEFAULT 0);
INSERT INTO notification_counts(user_id,unread) SELECT user_id,COUNT(*) FROM notifications WHERE read_at IS NULL GROUP BY user_id;
CREATE FUNCTION notification_counts_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
INSERT INTO notification_counts(user_id,unread) SELECT NEW.user_id,1 WHERE NEW.read_at IS NULL ON CONFLICT(user_id) DO UPDATE SET unread=notification_counts.unread+1;
RETURN NULL;
END; $$;
CREATE TRIGGER notification_counts_insert AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notification_counts_insert_fn();
CREATE FUNCTION notification_counts_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
IF NEW.read_at IS NOT DISTINCT FROM OLD.read_at AND NEW.user_id=OLD.user_id THEN RETURN NULL; END IF;
UPDATE notification_counts SET unread=unread-1 WHERE user_id=OLD.user_id AND OLD.read_at IS NULL;
INSERT INTO notification_counts(user_id,unread) SELECT NEW.user_id,1 WHERE NEW.read_at IS NULL ON CONFLICT(user_id) DO UPDATE SET unread=notification_counts.unread+1;
RETURN NULL;
END; $$;
CREATE TRIGGER notification_counts_update AFTER UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION notification_counts_update_fn();
CREATE FUNCTION notification_counts_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
UPDATE notification_counts SET unread=unread-1 WHERE user_id=OLD.user_id AND OLD.read_at IS NULL;
RETURN NULL;
END; $$;
CREATE TRIGGER notification_counts_delete AFTER DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION notification_counts_delete_fn();
