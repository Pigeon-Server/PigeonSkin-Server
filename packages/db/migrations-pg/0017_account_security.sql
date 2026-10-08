-- PostgreSQL 版迁移（自 packages/db/migrations/0017_account_security.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

CREATE TABLE account_security (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version BIGINT NOT NULL DEFAULT 0,
  email_enabled BIGINT NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_last_step BIGINT NOT NULL DEFAULT -1,
  webauthn_user_id TEXT NOT NULL UNIQUE
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL,
  transports TEXT NOT NULL,
  device_type TEXT NOT NULL,
  backed_up BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE security_challenges (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  purpose TEXT NOT NULL,
  version BIGINT,
  credentials_hash TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  attempts BIGINT NOT NULL DEFAULT 0,
  email_hash TEXT,
  email_expires_at BIGINT,
  mail_sent_at BIGINT,
  claim TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX security_challenges_user ON security_challenges(user_id);
CREATE INDEX security_challenges_expiry ON security_challenges(expires_at);

CREATE TABLE security_reauth (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version BIGINT NOT NULL,
  claim TEXT,
  expires_at BIGINT NOT NULL
);

CREATE FUNCTION security_password_changed_fn() RETURNS trigger AS $$
BEGIN
  DELETE FROM security_challenges WHERE user_id = NEW.id;
  DELETE FROM security_reauth WHERE user_id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER security_password_changed AFTER UPDATE OF password_hash, role ON users
FOR EACH ROW WHEN (NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.role IS DISTINCT FROM OLD.role)
EXECUTE FUNCTION security_password_changed_fn();

CREATE FUNCTION security_user_deleted_fn() RETURNS trigger AS $$
BEGIN
  DELETE FROM account_security WHERE user_id = OLD.id;
  DELETE FROM passkeys WHERE user_id = OLD.id;
  DELETE FROM recovery_codes WHERE user_id = OLD.id;
  DELETE FROM security_challenges WHERE user_id = OLD.id;
  DELETE FROM security_reauth WHERE user_id = OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER security_user_deleted AFTER DELETE ON users
FOR EACH ROW EXECUTE FUNCTION security_user_deleted_fn();
