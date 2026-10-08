-- MySQL 8.4 版迁移（自 packages/db/migrations/0007_oauth.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE connect_clients ADD COLUMN user_id BIGINT, ADD CONSTRAINT connect_clients_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX connect_clients_owner ON connect_clients(user_id);

CREATE TABLE oauth_login_states (
  id           VARCHAR(128) PRIMARY KEY,
  provider     VARCHAR(64) NOT NULL,
  browser_hash VARCHAR(128) NOT NULL,
  user_id      BIGINT,
  session_id   VARCHAR(128),
  verifier     TEXT NOT NULL,
  destination  VARCHAR(4096) NOT NULL,
  expires_at   BIGINT NOT NULL,
  CONSTRAINT oauth_login_states_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX oauth_login_states_expiry ON oauth_login_states(expires_at);
CREATE INDEX connect_refresh_grant ON connect_refresh(grant_id);
CREATE INDEX connect_codes_expiry ON connect_codes(expires_at);
CREATE INDEX connect_refresh_expiry ON connect_refresh(expires_at);

ALTER TABLE connect_grants ADD COLUMN auth_time BIGINT NOT NULL DEFAULT 0;

CREATE TABLE connect_responses (
  id         VARCHAR(128) PRIMARY KEY,
  user_id    BIGINT,
  body       TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  CONSTRAINT connect_responses_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
