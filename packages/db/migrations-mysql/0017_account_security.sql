-- MySQL 8.4 版迁移（自 packages/db/migrations/0017_account_security.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- 方言差异说明：MySQL 触发器不支持 WHEN 子句，条件移入触发器体 IF ... END IF。

CREATE TABLE account_security (
  user_id         BIGINT PRIMARY KEY,
  version         BIGINT NOT NULL DEFAULT 0,
  email_enabled   BIGINT NOT NULL DEFAULT 0,
  totp_secret     VARCHAR(256),
  totp_last_step  BIGINT NOT NULL DEFAULT -1,
  webauthn_user_id VARCHAR(256) NOT NULL,
  UNIQUE KEY account_security_webauthn_unique (webauthn_user_id),
  CONSTRAINT account_security_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE passkeys (
  id          VARCHAR(512) PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  name        VARCHAR(4096) NOT NULL,
  public_key  TEXT NOT NULL,
  counter     BIGINT NOT NULL,
  transports  TEXT NOT NULL,
  device_type VARCHAR(64) NOT NULL,
  backed_up   BIGINT NOT NULL,
  created_at  BIGINT NOT NULL,
  CONSTRAINT passkeys_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE recovery_codes (
  id      VARCHAR(128) PRIMARY KEY,
  user_id BIGINT NOT NULL,
  CONSTRAINT recovery_codes_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE security_challenges (
  id               VARCHAR(128) PRIMARY KEY,
  browser_hash     VARCHAR(128) NOT NULL,
  user_id          BIGINT,
  session_id       VARCHAR(128),
  purpose          VARCHAR(64) NOT NULL,
  version          BIGINT,
  credentials_hash VARCHAR(256),
  payload          TEXT NOT NULL,
  attempts         BIGINT NOT NULL DEFAULT 0,
  email_hash       VARCHAR(128),
  email_expires_at BIGINT,
  mail_sent_at     BIGINT,
  claim            VARCHAR(512),
  created_at       BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  CONSTRAINT security_challenges_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX security_challenges_user ON security_challenges(user_id);
CREATE INDEX security_challenges_expiry ON security_challenges(expires_at);

CREATE TABLE security_reauth (
  session_id VARCHAR(128) PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  version    BIGINT NOT NULL,
  claim      VARCHAR(512),
  expires_at BIGINT NOT NULL,
  CONSTRAINT security_reauth_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT security_reauth_user_fk    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


CREATE TRIGGER security_password_changed_challenges AFTER UPDATE ON users
FOR EACH ROW
  DELETE FROM security_challenges WHERE user_id = new.id
    AND (NOT (new.password_hash <=> old.password_hash) OR NOT (new.role <=> old.role));

CREATE TRIGGER security_password_changed_reauth AFTER UPDATE ON users
FOR EACH ROW
  DELETE FROM security_reauth WHERE user_id = new.id
    AND (NOT (new.password_hash <=> old.password_hash) OR NOT (new.role <=> old.role));

-- 级联删除本应靠外键 ON DELETE CASCADE；这里沿用原迁移的显式触发器，
-- 拆成单语句触发器（MySQL 触发器体多语句需要 DELIMITER，执行器不支持）。
CREATE TRIGGER security_user_deleted_account AFTER DELETE ON users
FOR EACH ROW
  DELETE FROM account_security WHERE user_id = old.id;
CREATE TRIGGER security_user_deleted_passkeys AFTER DELETE ON users
FOR EACH ROW
  DELETE FROM passkeys WHERE user_id = old.id;
CREATE TRIGGER security_user_deleted_recovery AFTER DELETE ON users
FOR EACH ROW
  DELETE FROM recovery_codes WHERE user_id = old.id;
CREATE TRIGGER security_user_deleted_challenges AFTER DELETE ON users
FOR EACH ROW
  DELETE FROM security_challenges WHERE user_id = old.id;
CREATE TRIGGER security_user_deleted_reauth AFTER DELETE ON users
FOR EACH ROW
  DELETE FROM security_reauth WHERE user_id = old.id;
