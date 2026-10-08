-- PostgreSQL 版迁移（自 packages/db/migrations/0006_ygg_connect.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- ygg_uuid_guard：CHECK 约束照搬；数据自检 INSERT ... SELECT 照搬。
CREATE TABLE ygg_uuid_guard (value BIGINT CONSTRAINT uuid_case_conflict CHECK (value = 0));
INSERT INTO ygg_uuid_guard SELECT count(*) FROM (SELECT lower(name) FROM uuid GROUP BY lower(name) HAVING count(*) > 1) AS dup;
DROP TABLE ygg_uuid_guard;

-- COLLATE NOCASE 比较 → lower(a) = lower(b)
CREATE TABLE uuid_archive AS SELECT name, uuid FROM uuid WHERE NOT EXISTS (SELECT 1 FROM players WHERE lower(players.name) = lower(uuid.name));
ALTER TABLE uuid RENAME TO uuid_legacy;

-- WITHOUT ROWID 删除（PG 无对应，主键本身就是聚簇候选）。
-- name 的 COLLATE NOCASE UNIQUE → lower(name) 唯一索引。
CREATE TABLE uuid (
  player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  version BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uuid_name_nocase_unique ON uuid(lower(name));

INSERT INTO uuid (player_id, name, uuid) SELECT p.id, p.name, u.uuid FROM uuid_legacy u JOIN players p ON lower(p.name) = lower(u.name);
DROP TABLE uuid_legacy;

CREATE FUNCTION uuid_player_renamed_fn() RETURNS trigger AS $$
BEGIN
  UPDATE uuid SET name = NEW.name, version = version + 1 WHERE player_id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER uuid_player_renamed AFTER UPDATE OF name ON players
FOR EACH ROW WHEN (NEW.name IS DISTINCT FROM OLD.name)
EXECUTE FUNCTION uuid_player_renamed_fn();

DELETE FROM ygg_tokens;
ALTER TABLE ygg_tokens ADD COLUMN player_id BIGINT REFERENCES players(id) ON DELETE CASCADE;
ALTER TABLE ygg_tokens ADD COLUMN profile_uuid TEXT;
ALTER TABLE ygg_tokens ADD COLUMN profile_version BIGINT;
ALTER TABLE ygg_tokens ADD COLUMN source TEXT NOT NULL DEFAULT 'traditional';
ALTER TABLE ygg_tokens ADD COLUMN grant_id TEXT;
ALTER TABLE ygg_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]';

CREATE TABLE ygg_sessions (
  server_hash TEXT NOT NULL,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  profile_uuid TEXT NOT NULL,
  profile_version BIGINT NOT NULL,
  token_id TEXT NOT NULL REFERENCES ygg_tokens(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (server_hash, player_id)
);
CREATE INDEX ygg_sessions_expiry ON ygg_sessions(expires_at);

CREATE TABLE connect_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT,
  redirect_uris TEXT NOT NULL,
  enabled BIGINT NOT NULL DEFAULT 1,
  shared BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX connect_shared_client ON connect_clients(shared) WHERE shared = 1;

CREATE TABLE connect_keys (
  kid TEXT PRIMARY KEY,
  private_jwk TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  retired_at BIGINT
);
CREATE UNIQUE INDEX connect_active_key ON connect_keys((1)) WHERE retired_at IS NULL;

CREATE TABLE connect_grants (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES connect_clients(id) ON DELETE CASCADE,
  player_id BIGINT REFERENCES players(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX connect_grants_user ON connect_grants(user_id);

CREATE TABLE connect_interactions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES connect_clients(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  params TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT,
  consume_key TEXT
);

CREATE TABLE connect_codes (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES connect_grants(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT,
  nonce TEXT,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT,
  consume_key TEXT
);

CREATE TABLE connect_refresh (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES connect_grants(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT,
  consume_key TEXT
);

CREATE TABLE connect_devices (
  id TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES connect_clients(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  grant_id TEXT REFERENCES connect_grants(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  next_poll_at BIGINT NOT NULL DEFAULT 0,
  interval_seconds BIGINT NOT NULL DEFAULT 5,
  denied BIGINT NOT NULL DEFAULT 0,
  consumed_at BIGINT,
  consume_key TEXT
);

CREATE FUNCTION connect_user_credentials_fn() RETURNS trigger AS $$
BEGIN
  DELETE FROM ygg_tokens WHERE user_id = NEW.id;
  UPDATE connect_grants SET revoked_at = (EXTRACT(EPOCH FROM now())*1000)::BIGINT WHERE user_id = NEW.id AND revoked_at IS NULL;
  DELETE FROM ygg_sessions WHERE player_id IN (SELECT id FROM players WHERE user_id = NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER connect_user_credentials AFTER UPDATE OF password_hash, email, role ON users
FOR EACH ROW WHEN (NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role = 'banned')
EXECUTE FUNCTION connect_user_credentials_fn();
