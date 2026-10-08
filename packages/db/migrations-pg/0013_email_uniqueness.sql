-- PostgreSQL 版迁移（自 packages/db/migrations/0013_email_uniqueness.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- COLLATE NOCASE 比较 → lower(a) = lower(b)；RAISE(ABORT) → RAISE EXCEPTION
CREATE FUNCTION users_email_insert_unique_fn() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(NEW.email)) THEN
    RAISE EXCEPTION 'UNIQUE constraint failed: users.email';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_email_insert_unique BEFORE INSERT ON users
FOR EACH ROW WHEN (NEW.legacy_email_conflict = 0)
EXECUTE FUNCTION users_email_insert_unique_fn();

CREATE FUNCTION users_email_update_unique_fn() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id != OLD.id AND lower(email) = lower(NEW.email)) THEN
    RAISE EXCEPTION 'UNIQUE constraint failed: users.email';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_email_update_unique BEFORE UPDATE OF email ON users
FOR EACH ROW WHEN (NEW.email IS DISTINCT FROM OLD.email)
EXECUTE FUNCTION users_email_update_unique_fn();
