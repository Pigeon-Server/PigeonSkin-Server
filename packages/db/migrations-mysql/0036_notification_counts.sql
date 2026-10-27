CREATE TABLE notification_counts(user_id BIGINT PRIMARY KEY,unread BIGINT NOT NULL DEFAULT 0,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
INSERT INTO notification_counts(user_id,unread) SELECT user_id,COUNT(*) FROM notifications WHERE read_at IS NULL GROUP BY user_id;
CREATE TRIGGER notification_counts_insert AFTER INSERT ON notifications FOR EACH ROW BEGIN
INSERT INTO notification_counts(user_id,unread) SELECT NEW.user_id,1 WHERE NEW.read_at IS NULL ON DUPLICATE KEY UPDATE unread=notification_counts.unread+1;
END;
CREATE TRIGGER notification_counts_update AFTER UPDATE ON notifications FOR EACH ROW BEGIN
IF NOT (NEW.read_at <=> OLD.read_at) OR NEW.user_id<>OLD.user_id THEN
UPDATE notification_counts SET unread=unread-1 WHERE user_id=OLD.user_id AND OLD.read_at IS NULL;
INSERT INTO notification_counts(user_id,unread) SELECT NEW.user_id,1 WHERE NEW.read_at IS NULL ON DUPLICATE KEY UPDATE unread=notification_counts.unread+1;
END IF;
END;
CREATE TRIGGER notification_counts_delete AFTER DELETE ON notifications FOR EACH ROW BEGIN
UPDATE notification_counts SET unread=unread-1 WHERE user_id=OLD.user_id AND OLD.read_at IS NULL;
END;
