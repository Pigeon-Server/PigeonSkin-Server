-- MySQL 8.4 版迁移（自 packages/db/migrations/0006_ygg_connect.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- 方言差异说明：
--   • ai_ci 排序规则本身大小写不敏感，原 COLLATE NOCASE 比较直接去掉修饰。
--   • SQLite 部分唯一索引（WHERE shared = 1 / WHERE retired_at IS NULL）
--     在 MySQL 中用 VIRTUAL 生成列 + 唯一索引等价改写：生成列在条件不满足时
--     取 NULL，而唯一索引不约束 NULL，行为与部分索引一致。
--   • 触发器 WHEN 子句改写为触发器体内的 IF ... END IF。

-- uuid 表中若存在同名（大小写不敏感）角色则中止迁移（ai_ci 下 GROUP BY lower(name)
-- 与 GROUP BY name 等价，保留 lower() 以贴合原语义）。
CREATE TABLE ygg_uuid_guard (value BIGINT CONSTRAINT uuid_case_conflict CHECK (value = 0));
INSERT INTO ygg_uuid_guard SELECT count(*) FROM (SELECT lower(name) AS lname FROM uuid GROUP BY lower(name) HAVING count(*) > 1) t;
DROP TABLE ygg_uuid_guard;

-- 未关联到现有玩家的 uuid 记录归档（ai_ci 下 name 比较已大小写不敏感）。
CREATE TABLE uuid_archive AS SELECT name, uuid FROM uuid WHERE NOT EXISTS (SELECT 1 FROM players WHERE players.name = uuid.name);
ALTER TABLE uuid RENAME TO uuid_legacy;

CREATE TABLE uuid (
  player_id BIGINT PRIMARY KEY,
  name      VARCHAR(64) NOT NULL,
  uuid      VARCHAR(64) NOT NULL,
  version   BIGINT NOT NULL DEFAULT 0,
  UNIQUE KEY uuid_name_unique (name),
  UNIQUE KEY uuid_value_unique (uuid),
  CONSTRAINT uuid_player_fk FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO uuid (player_id, name, uuid) SELECT p.id, p.name, u.uuid FROM uuid_legacy u JOIN players p ON p.name = u.name;

DROP TABLE uuid_legacy;


CREATE TRIGGER uuid_player_renamed AFTER UPDATE ON players
FOR EACH ROW
  UPDATE uuid SET name = new.name, version = version + 1 WHERE player_id = new.id AND NOT (new.name <=> old.name);

DELETE FROM ygg_tokens;
ALTER TABLE ygg_tokens ADD COLUMN player_id BIGINT, ADD CONSTRAINT ygg_tokens_player_fk FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
ALTER TABLE ygg_tokens ADD COLUMN profile_uuid VARCHAR(64);
ALTER TABLE ygg_tokens ADD COLUMN profile_version BIGINT;
ALTER TABLE ygg_tokens ADD COLUMN source VARCHAR(32) NOT NULL DEFAULT 'traditional';
ALTER TABLE ygg_tokens ADD COLUMN grant_id VARCHAR(128);
ALTER TABLE ygg_tokens ADD COLUMN scopes TEXT;

CREATE TABLE ygg_sessions (
  server_hash     VARCHAR(128) NOT NULL,
  player_id       BIGINT NOT NULL,
  profile_uuid    VARCHAR(64) NOT NULL,
  profile_version BIGINT NOT NULL,
  token_id        VARCHAR(128) NOT NULL,
  ip              VARCHAR(64) NOT NULL,
  expires_at      BIGINT NOT NULL,
  PRIMARY KEY (server_hash, player_id),
  CONSTRAINT ygg_sessions_player_fk FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  CONSTRAINT ygg_sessions_token_fk  FOREIGN KEY (token_id)  REFERENCES ygg_tokens(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX ygg_sessions_expiry ON ygg_sessions(expires_at);

CREATE TABLE connect_clients (
  id           VARCHAR(128) PRIMARY KEY,
  name         VARCHAR(4096) NOT NULL,
  secret_hash  VARCHAR(128),
  redirect_uris TEXT NOT NULL,
  enabled      BIGINT NOT NULL DEFAULT 1,
  shared       BIGINT NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  -- 等价于原部分唯一索引 CREATE UNIQUE INDEX connect_shared_client
  -- ON connect_clients(shared) WHERE shared = 1：
  -- 仅 shared = 1 的行生成列取 1，其余取 NULL（NULL 不参与唯一约束）。
  shared_token BIGINT GENERATED ALWAYS AS (IF(shared = 1, 1, NULL)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE UNIQUE INDEX connect_shared_client ON connect_clients(shared_token);

CREATE TABLE connect_keys (
  kid         VARCHAR(128) PRIMARY KEY,
  private_jwk TEXT NOT NULL,
  public_jwk  TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  retired_at  BIGINT,
  -- 等价于原部分唯一索引 CREATE UNIQUE INDEX connect_active_key
  -- ON connect_keys((1)) WHERE retired_at IS NULL：
  -- 仅 retired_at IS NULL 的行生成列取 1，保证至多一把未退役密钥。
  active_slot BIGINT GENERATED ALWAYS AS (IF(retired_at IS NULL, 1, NULL)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE UNIQUE INDEX connect_active_key ON connect_keys(active_slot);

CREATE TABLE connect_grants (
  id         VARCHAR(128) PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  client_id  VARCHAR(128) NOT NULL,
  player_id  BIGINT,
  scopes     TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  CONSTRAINT connect_grants_user_fk   FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT connect_grants_client_fk FOREIGN KEY (client_id) REFERENCES connect_clients(id) ON DELETE CASCADE,
  CONSTRAINT connect_grants_player_fk FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX connect_grants_user ON connect_grants(user_id);

CREATE TABLE connect_interactions (
  id          VARCHAR(128) PRIMARY KEY,
  client_id   VARCHAR(128) NOT NULL,
  user_id     BIGINT,
  params      TEXT NOT NULL,
  expires_at  BIGINT NOT NULL,
  consumed_at BIGINT,
  consume_key VARCHAR(128),
  CONSTRAINT connect_interactions_client_fk FOREIGN KEY (client_id) REFERENCES connect_clients(id) ON DELETE CASCADE,
  CONSTRAINT connect_interactions_user_fk   FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE connect_codes (
  id          VARCHAR(128) PRIMARY KEY,
  grant_id    VARCHAR(128) NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge   VARCHAR(256),
  nonce       VARCHAR(256),
  expires_at  BIGINT NOT NULL,
  consumed_at BIGINT,
  consume_key VARCHAR(128),
  CONSTRAINT connect_codes_grant_fk FOREIGN KEY (grant_id) REFERENCES connect_grants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE connect_refresh (
  id          VARCHAR(128) PRIMARY KEY,
  grant_id    VARCHAR(128) NOT NULL,
  scopes      TEXT NOT NULL,
  expires_at  BIGINT NOT NULL,
  consumed_at BIGINT,
  consume_key VARCHAR(128),
  CONSTRAINT connect_refresh_grant_fk FOREIGN KEY (grant_id) REFERENCES connect_grants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE connect_devices (
  id              VARCHAR(128) PRIMARY KEY,
  user_code_hash  VARCHAR(128) NOT NULL,
  client_id       VARCHAR(128) NOT NULL,
  scopes          TEXT NOT NULL,
  grant_id        VARCHAR(128),
  expires_at      BIGINT NOT NULL,
  next_poll_at    BIGINT NOT NULL DEFAULT 0,
  interval_seconds BIGINT NOT NULL DEFAULT 5,
  denied          BIGINT NOT NULL DEFAULT 0,
  consumed_at     BIGINT,
  consume_key     VARCHAR(128),
  UNIQUE KEY connect_devices_user_code_unique (user_code_hash),
  CONSTRAINT connect_devices_client_fk FOREIGN KEY (client_id) REFERENCES connect_clients(id) ON DELETE CASCADE,
  CONSTRAINT connect_devices_grant_fk  FOREIGN KEY (grant_id)  REFERENCES connect_grants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- 凭据变更（改密/改邮箱/封禁）后吊销该用户的全部 Yggdrasil 令牌、
-- Connect 授权与会话。原 WHEN 条件移入触发器体。
-- 凭据变更即撤销令牌/授权/会话；条件写进行级 WHERE（MySQL 无 UPDATE OF）。
CREATE TRIGGER connect_user_credentials_tokens AFTER UPDATE ON users
FOR EACH ROW
  DELETE FROM ygg_tokens WHERE user_id = new.id
    AND (NOT (new.password_hash <=> old.password_hash) OR NOT (new.email <=> old.email) OR new.role = 'banned');

CREATE TRIGGER connect_user_credentials_grants AFTER UPDATE ON users
FOR EACH ROW
  UPDATE connect_grants SET revoked_at = (UNIX_TIMESTAMP() * 1000) WHERE user_id = new.id AND revoked_at IS NULL
    AND (NOT (new.password_hash <=> old.password_hash) OR NOT (new.email <=> old.email) OR new.role = 'banned');

CREATE TRIGGER connect_user_credentials_sessions AFTER UPDATE ON users
FOR EACH ROW
  DELETE FROM ygg_sessions WHERE player_id IN (SELECT id FROM players WHERE user_id = new.id)
    AND (NOT (new.password_hash <=> old.password_hash) OR NOT (new.email <=> old.email) OR new.role = 'banned');
