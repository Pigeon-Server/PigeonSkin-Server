CREATE TABLE account_security (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_last_step INTEGER NOT NULL DEFAULT -1,
  webauthn_user_id TEXT NOT NULL UNIQUE
);
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX passkeys_user ON passkeys(user_id);
CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);
CREATE TABLE security_challenges (
  id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  purpose TEXT NOT NULL,
  version INTEGER,
  credentials_hash TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  email_hash TEXT,
  email_expires_at INTEGER,
  mail_sent_at INTEGER,
  claim TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX security_challenges_user ON security_challenges(user_id);
CREATE INDEX security_challenges_expiry ON security_challenges(expires_at);
CREATE TABLE security_reauth (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  claim TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TRIGGER security_password_changed AFTER UPDATE OF password_hash, role ON users
WHEN NEW.password_hash != OLD.password_hash OR NEW.role != OLD.role
BEGIN
  DELETE FROM security_challenges WHERE user_id = NEW.id;
  DELETE FROM security_reauth WHERE user_id = NEW.id;
END;
CREATE TRIGGER security_user_deleted AFTER DELETE ON users
BEGIN
  DELETE FROM account_security WHERE user_id = OLD.id;
  DELETE FROM passkeys WHERE user_id = OLD.id;
  DELETE FROM recovery_codes WHERE user_id = OLD.id;
  DELETE FROM security_challenges WHERE user_id = OLD.id;
  DELETE FROM security_reauth WHERE user_id = OLD.id;
END;
