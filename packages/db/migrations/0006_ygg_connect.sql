CREATE TABLE ygg_uuid_guard (value INTEGER CONSTRAINT uuid_case_conflict CHECK (value = 0));
INSERT INTO ygg_uuid_guard SELECT count(*) FROM (SELECT lower(name) FROM uuid GROUP BY lower(name) HAVING count(*) > 1);
DROP TABLE ygg_uuid_guard;
CREATE TABLE uuid_archive AS SELECT name, uuid FROM uuid WHERE NOT EXISTS (SELECT 1 FROM players WHERE players.name = uuid.name COLLATE NOCASE);
ALTER TABLE uuid RENAME TO uuid_legacy;
CREATE TABLE uuid (
  player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  uuid TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
INSERT INTO uuid (player_id, name, uuid) SELECT p.id, p.name, u.uuid FROM uuid_legacy u JOIN players p ON p.name = u.name COLLATE NOCASE;
DROP TABLE uuid_legacy;
CREATE TRIGGER uuid_player_renamed AFTER UPDATE OF name ON players WHEN NEW.name IS NOT OLD.name
BEGIN
  UPDATE uuid SET name = NEW.name, version = version + 1 WHERE player_id = NEW.id;
END;
DELETE FROM ygg_tokens;
ALTER TABLE ygg_tokens ADD COLUMN player_id INTEGER REFERENCES players(id) ON DELETE CASCADE;
ALTER TABLE ygg_tokens ADD COLUMN profile_uuid TEXT;
ALTER TABLE ygg_tokens ADD COLUMN profile_version INTEGER;
ALTER TABLE ygg_tokens ADD COLUMN source TEXT NOT NULL DEFAULT 'traditional';
ALTER TABLE ygg_tokens ADD COLUMN grant_id TEXT;
ALTER TABLE ygg_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]';
CREATE TABLE ygg_sessions (
  server_hash TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  profile_uuid TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  token_id TEXT NOT NULL REFERENCES ygg_tokens(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (server_hash, player_id)
);
CREATE INDEX ygg_sessions_expiry ON ygg_sessions(expires_at);
CREATE TABLE connect_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT,
  redirect_uris TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  shared INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX connect_shared_client ON connect_clients(shared) WHERE shared = 1;
CREATE TABLE connect_keys (
  kid TEXT PRIMARY KEY,
  private_jwk TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE UNIQUE INDEX connect_active_key ON connect_keys((1)) WHERE retired_at IS NULL;
CREATE TABLE connect_grants (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES connect_clients(id) ON DELETE CASCADE,
  player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX connect_grants_user ON connect_grants(user_id);
CREATE TABLE connect_interactions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES connect_clients(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  params TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_key TEXT
);
CREATE TABLE connect_codes (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES connect_grants(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT,
  nonce TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_key TEXT
);
CREATE TABLE connect_refresh (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES connect_grants(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consume_key TEXT
);
CREATE TABLE connect_devices (
  id TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES connect_clients(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  grant_id TEXT REFERENCES connect_grants(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  denied INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  consume_key TEXT
);
CREATE TRIGGER connect_user_credentials AFTER UPDATE OF password_hash, email, role ON users
WHEN NEW.password_hash IS NOT OLD.password_hash OR NEW.email IS NOT OLD.email OR NEW.role = 'banned'
BEGIN
  DELETE FROM ygg_tokens WHERE user_id = NEW.id;
  UPDATE connect_grants SET revoked_at = unixepoch() * 1000 WHERE user_id = NEW.id AND revoked_at IS NULL;
  DELETE FROM ygg_sessions WHERE player_id IN (SELECT id FROM players WHERE user_id = NEW.id);
END;
