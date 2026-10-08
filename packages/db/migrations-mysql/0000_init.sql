-- MySQL 8.4 版迁移（自 packages/db/migrations/0000_init.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- Blessing Skin 初始 schema
--
-- SQLite 原版说明（保留）：
--   • users.email / players.name 需要 `COLLATE NOCASE` 唯一索引。
--     MySQL 版改用表级排序规则 utf8mb4_0900_ai_ci（大小写不敏感）实现同等语义，
--     唯一索引去掉 COLLATE 修饰（users_email_unique 等）。
--   • users/players/textures 需要 AUTO_INCREMENT 保证 id 永不复用
--     （InnoDB AUTO_INCREMENT 计数器不复用 id）。
--   • settings 的主键是 (key, locale) 复合键。
--
-- 设计说明见 docs/rewrite/04-database-schema.md

-- ─────────────────────────────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                       BIGINT PRIMARY KEY AUTO_INCREMENT,
  email                    VARCHAR(512)  NOT NULL,
  email_verified_at        BIGINT,
  nickname                 VARCHAR(512)  NOT NULL DEFAULT '',
  locale                   VARCHAR(16),
  score                    BIGINT        NOT NULL DEFAULT 1000,
  avatar_texture_id        BIGINT,

  -- 凭据。password_hash 是自描述字符串 `<algo>:<payload>`，
  -- 因此迁移期旧哈希与新 PBKDF2 哈希可以共存一列，按第一段分发即可。
  password_hash            VARCHAR(1024) NOT NULL,
  password_rehash_required BIGINT        NOT NULL DEFAULT 0,

  role                     VARCHAR(32)   NOT NULL DEFAULT 'normal',
  registration_ip          VARCHAR(64),
  is_dark_mode             BIGINT        NOT NULL DEFAULT 0,
  last_sign_at             BIGINT,
  created_at               BIGINT        NOT NULL,
  updated_at               BIGINT        NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE UNIQUE INDEX users_email_unique ON users(email);
CREATE INDEX users_role_idx       ON users(role);
CREATE INDEX users_created_at_idx ON users(created_at);
CREATE INDEX users_reg_ip_idx     ON users(registration_ip);

-- ─────────────────────────────────────────────────────────────────────────────
-- sessions —— 服务端会话，可撤销。存的是 sha256(token)，原始令牌从不落库。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id                  VARCHAR(128) PRIMARY KEY,
  user_id             BIGINT NOT NULL,
  created_at          BIGINT NOT NULL,
  last_seen_at        BIGINT NOT NULL,
  expires_at          BIGINT NOT NULL,
  absolute_expires_at BIGINT NOT NULL,
  ip                  VARCHAR(64),
  user_agent          TEXT,
  revoked_at          BIGINT,
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX sessions_user_id_idx    ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- players
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE players (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id         BIGINT NOT NULL,
  name            VARCHAR(64) NOT NULL,
  skin_texture_id BIGINT,
  cape_texture_id BIGINT,
  created_at      BIGINT,
  updated_at      BIGINT NOT NULL,
  CONSTRAINT players_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE UNIQUE INDEX players_name_unique ON players(name);
CREATE INDEX players_user_id_idx ON players(user_id);
CREATE INDEX players_skin_idx    ON players(skin_texture_id);
CREATE INDEX players_cape_idx    ON players(cape_texture_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- textures —— 只有元数据；字节位于 R2 键 `textures/<hash>.png`
--
-- 注意 hash **有意不加唯一约束**：旧库允许同哈希多行（去重规则依赖 uploader
-- 与可见性），加约束会强制重映射 tid，而 R2 的对象身份已由哈希键去重。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE textures (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  hash        VARCHAR(128) NOT NULL,
  kind        VARCHAR(32)  NOT NULL,
  model       VARCHAR(32),
  name        VARCHAR(4096) NOT NULL,
  uploader_id BIGINT,
  size_bytes  BIGINT       NOT NULL,
  visibility  VARCHAR(32)  NOT NULL DEFAULT 'public',
  width       BIGINT       NOT NULL,
  height      BIGINT       NOT NULL,
  likes       BIGINT       NOT NULL DEFAULT 0,
  created_at  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL,
  CONSTRAINT textures_uploader_fk FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX textures_hash_idx        ON textures(hash);
CREATE INDEX textures_uploader_idx    ON textures(uploader_id);
CREATE INDEX textures_vis_created_idx ON textures(visibility, created_at DESC);
CREATE INDEX textures_vis_likes_idx   ON textures(visibility, likes DESC);
CREATE INDEX textures_kind_vis_idx    ON textures(kind, visibility);

-- ─────────────────────────────────────────────────────────────────────────────
-- closet —— 取代旧 user_closet（旧表没有主键也没有索引）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE closet (
  user_id    BIGINT NOT NULL,
  texture_id BIGINT NOT NULL,
  item_name  VARCHAR(4096),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, texture_id),
  CONSTRAINT closet_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT closet_texture_fk FOREIGN KEY (texture_id) REFERENCES textures(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX closet_texture_id_idx   ON closet(texture_id);
CREATE INDEX closet_user_created_idx ON closet(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- reports
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE reports (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  texture_id  BIGINT NOT NULL,
  uploader_id BIGINT,
  reporter_id BIGINT NOT NULL,
  reason      TEXT   NOT NULL,
  status      VARCHAR(32) NOT NULL DEFAULT 'pending',
  reviewer_id BIGINT,
  resolution  TEXT,
  created_at  BIGINT NOT NULL,
  reviewed_at BIGINT,
  CONSTRAINT reports_texture_fk  FOREIGN KEY (texture_id)  REFERENCES textures(id) ON DELETE CASCADE,
  CONSTRAINT reports_uploader_fk FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT reports_reporter_fk FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT reports_reviewer_fk FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE UNIQUE INDEX reports_reporter_texture_unique ON reports(reporter_id, texture_id);
CREATE INDEX reports_status_created_idx ON reports(status, created_at DESC);
CREATE INDEX reports_texture_idx        ON reports(texture_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- notifications —— 取代 Laravel 的 UUID morph 表
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE notifications (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id    BIGINT NOT NULL,
  type       VARCHAR(64) NOT NULL,
  title      VARCHAR(4096) NOT NULL,
  body       TEXT,
  read_at    BIGINT,
  created_at BIGINT NOT NULL,
  CONSTRAINT notifications_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX notifications_user_unread_idx ON notifications(user_id, read_at, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- settings —— 运行时可改的配置。部署配置留在 wrangler 里。
--
-- locale 默认 '' 而不是 NULL：与 SQLite 版保持一致（主键列不取 NULL）。
-- value 可能存放较长的 JSON/文档内容，但 settings 主键列有 3072 字节上限，
-- key/locale 用 VARCHAR 时注意 utf8mb4 下索引长度；此处 key VARCHAR(191)、
-- locale VARCHAR(64) 足够（均为系统生成标识）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE settings (
  `key`      VARCHAR(191) NOT NULL,
  locale     VARCHAR(64)  NOT NULL DEFAULT '',
  value      TEXT         NOT NULL,
  updated_at BIGINT       NOT NULL,
  PRIMARY KEY (`key`, locale)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- 邮箱验证令牌 —— 一次性、会过期。
-- 旧版用的是**永久有效且可重复使用**的签名 URL，这里是有意收紧。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE verification_tokens (
  id          VARCHAR(128) PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  email       VARCHAR(4096) NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  consumed_at BIGINT,
  CONSTRAINT verification_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX verification_tokens_user_idx ON verification_tokens(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 密码重置令牌 —— 一次性、会过期。旧版在 1 小时窗口内可重复使用。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE password_reset_tokens (
  id          VARCHAR(128) PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  consumed_at BIGINT,
  CONSTRAINT password_reset_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- auth_attempts —— 权威的暴力破解锁定依据。
-- 与最终一致的 Cloudflare Rate Limiting binding 互补：后者适合吸收洪水，
-- 但无法强制精确计数，而锁定策略需要精确计数。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE auth_attempts (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  ip         VARCHAR(64) NOT NULL,
  identifier VARCHAR(512),
  kind       VARCHAR(32) NOT NULL,
  succeeded  BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX auth_attempts_ip_kind_created_idx ON auth_attempts(ip, kind, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log —— 管理员操作记录。小、只追加、保留成本低。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  actor_id    BIGINT,
  action      VARCHAR(128) NOT NULL,
  target_type VARCHAR(64),
  target_id   BIGINT,
  detail      TEXT,
  created_at  BIGINT NOT NULL,
  CONSTRAINT audit_log_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);

-- 前向引用外键：textures 建表于 users/players 之后，约束统一补挂
ALTER TABLE users   ADD CONSTRAINT users_avatar_fk FOREIGN KEY (avatar_texture_id) REFERENCES textures(id) ON DELETE SET NULL;
ALTER TABLE players ADD CONSTRAINT players_skin_fk FOREIGN KEY (skin_texture_id) REFERENCES textures(id) ON DELETE SET NULL;
ALTER TABLE players ADD CONSTRAINT players_cape_fk FOREIGN KEY (cape_texture_id) REFERENCES textures(id) ON DELETE SET NULL;
