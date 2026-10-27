CREATE TABLE notification_counts(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,unread BIGINT NOT NULL DEFAULT 0);
INSERT INTO notification_counts(user_id,unread) SELECT user_id,COUNT(*) FROM notifications WHERE read_at IS NULL GROUP BY user_id;
CREATE TRIGGER notification_counts_insert AFTER INSERT ON notifications BEGIN
INSERT INTO notification_counts(user_id,unread) SELECT NEW.user_id,1 WHERE NEW.read_at IS NULL ON CONFLICT(user_id) DO UPDATE SET unread=notification_counts.unread+1;
END;
CREATE TRIGGER notification_counts_update AFTER UPDATE ON notifications WHEN OLD.read_at IS NOT NEW.read_at OR OLD.user_id IS NOT NEW.user_id BEGIN
UPDATE notification_counts SET unread=unread-1 WHERE user_id=OLD.user_id AND OLD.read_at IS NULL;
INSERT INTO notification_counts(user_id,unread) SELECT NEW.user_id,1 WHERE NEW.read_at IS NULL ON CONFLICT(user_id) DO UPDATE SET unread=notification_counts.unread+1;
END;
CREATE TRIGGER notification_counts_delete AFTER DELETE ON notifications BEGIN
UPDATE notification_counts SET unread=unread-1 WHERE user_id=OLD.user_id AND OLD.read_at IS NULL;
END;
