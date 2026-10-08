-- PostgreSQL 版迁移（自 packages/db/migrations/0007_oauth.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE connect_clients ADD COLUMN user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX connect_clients_owner ON connect_clients(user_id);

CREATE TABLE oauth_login_states (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  verifier TEXT NOT NULL,
  destination TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX oauth_login_states_expiry ON oauth_login_states(expires_at);
CREATE INDEX connect_refresh_grant ON connect_refresh(grant_id);
CREATE INDEX connect_codes_expiry ON connect_codes(expires_at);
CREATE INDEX connect_refresh_expiry ON connect_refresh(expires_at);

ALTER TABLE connect_grants ADD COLUMN auth_time BIGINT NOT NULL DEFAULT 0;

CREATE TABLE connect_responses (
  id TEXT PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
