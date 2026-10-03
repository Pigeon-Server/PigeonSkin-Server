CREATE TRIGGER users_email_insert_unique BEFORE INSERT ON users
WHEN NEW.legacy_email_conflict = 0 AND EXISTS (SELECT 1 FROM users WHERE email = NEW.email COLLATE NOCASE)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: users.email');
END;
CREATE TRIGGER users_email_update_unique BEFORE UPDATE OF email ON users
WHEN NEW.email != OLD.email COLLATE NOCASE AND EXISTS (SELECT 1 FROM users WHERE id != OLD.id AND email = NEW.email COLLATE NOCASE)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: users.email');
END;
