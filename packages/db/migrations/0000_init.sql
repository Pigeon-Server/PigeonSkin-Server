-- Blessing Skin 初始 schema
--
-- 这份迁移是**手写**的，不是 drizzle-kit 生成的。原因：
--   • users.email / players.name 需要 `COLLATE NOCASE` 唯一索引
--     （SQLite 的 UNIQUE 默认区分大小写，而 MySQL 默认不区分 —— 不显式加
--      COLLATE 就会出现 `Notch` 与 `notch` 都能注册的行为变更）
--   • users/players/textures 需要 AUTOINCREMENT 保证 id 永不复用
--     （id 出现在 URL 里，复用会让新对象继承已删除对象的地址）
--   • settings 的主键是 (key, locale) 复合键
-- 这三样 drizzle-kit 都处理得不够好，所以 SQL 作为唯一事实来源，
-- Drizzle 只承担类型化查询层（见 src/schema.ts，字段与这里一一对应）。
--
-- 设计说明见 docs/rewrite/04-database-schema.md

-- ─────────────────────────────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  email                    TEXT    NOT NULL,
  email_verified_at        INTEGER,
  nickname                 TEXT    NOT NULL DEFAULT '',
  locale                   TEXT,
  score                    INTEGER NOT NULL DEFAULT 1000,
  avatar_texture_id        INTEGER REFERENCES textures(id) ON DELETE SET NULL,

  -- 凭据。password_hash 是自描述字符串 `<algo>:<payload>`，
  -- 因此迁移期旧哈希与新 PBKDF2 哈希可以共存一列，按第一段分发即可。
  password_hash            TEXT    NOT NULL,
  password_rehash_required INTEGER NOT NULL DEFAULT 0,

  role                     TEXT    NOT NULL DEFAULT 'normal',
  registration_ip          TEXT,
  is_dark_mode             INTEGER NOT NULL DEFAULT 0,
  last_sign_at             INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE UNIQUE INDEX users_email_unique ON users(email COLLATE NOCASE);
CREATE INDEX users_role_idx       ON users(role);
CREATE INDEX users_created_at_idx ON users(created_at);
CREATE INDEX users_reg_ip_idx     ON users(registration_ip);

-- ─────────────────────────────────────────────────────────────────────────────
-- sessions —— 服务端会话，可撤销。存的是 sha256(token)，原始令牌从不落库。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id                  TEXT    PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  ip                  TEXT,
  user_agent          TEXT,
  revoked_at          INTEGER
);

CREATE INDEX sessions_user_id_idx    ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- players
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE players (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  skin_texture_id INTEGER REFERENCES textures(id) ON DELETE SET NULL,
  cape_texture_id INTEGER REFERENCES textures(id) ON DELETE SET NULL,
  created_at      INTEGER,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX players_name_unique ON players(name COLLATE NOCASE);
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
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hash        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  model       TEXT,
  name        TEXT    NOT NULL,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  size_bytes  INTEGER NOT NULL,
  visibility  TEXT    NOT NULL DEFAULT 'public',
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  likes       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX textures_hash_idx        ON textures(hash);
CREATE INDEX textures_uploader_idx    ON textures(uploader_id);
CREATE INDEX textures_vis_created_idx ON textures(visibility, created_at DESC);
CREATE INDEX textures_vis_likes_idx   ON textures(visibility, likes DESC);
CREATE INDEX textures_kind_vis_idx    ON textures(kind, visibility);

-- ─────────────────────────────────────────────────────────────────────────────
-- closet —— 取代旧 user_closet（旧表没有主键也没有索引）
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE closet (
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  texture_id INTEGER NOT NULL REFERENCES textures(id) ON DELETE CASCADE,
  item_name  TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, texture_id)
);

CREATE INDEX closet_texture_id_idx   ON closet(texture_id);
CREATE INDEX closet_user_created_idx ON closet(user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- reports
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  texture_id  INTEGER NOT NULL REFERENCES textures(id) ON DELETE CASCADE,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution  TEXT,
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE UNIQUE INDEX reports_reporter_texture_unique ON reports(reporter_id, texture_id);
CREATE INDEX reports_status_created_idx ON reports(status, created_at DESC);
CREATE INDEX reports_texture_idx        ON reports(texture_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- notifications —— 取代 Laravel 的 UUID morph 表
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT,
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX notifications_user_unread_idx ON notifications(user_id, read_at, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- settings —— 运行时可改的配置。部署配置留在 wrangler 里。
--
-- locale 默认 '' 而不是 NULL：SQLite 主键里的 NULL 彼此不相等，
-- 用 NULL 的话 (key, NULL) 行不会唯一。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE settings (
  key        TEXT    NOT NULL,
  locale     TEXT    NOT NULL DEFAULT '',
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, locale)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 邮箱验证令牌 —— 一次性、会过期。
-- 旧版用的是**永久有效且可重复使用**的签名 URL，这里是有意收紧。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE verification_tokens (
  id          TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX verification_tokens_user_idx ON verification_tokens(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 密码重置令牌 —— 一次性、会过期。旧版在 1 小时窗口内可重复使用。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE password_reset_tokens (
  id          TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- auth_attempts —— 权威的暴力破解锁定依据。
-- 与最终一致的 Cloudflare Rate Limiting binding 互补：后者适合吸收洪水，
-- 但无法强制精确计数，而锁定策略需要精确计数。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE auth_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT    NOT NULL,
  identifier TEXT,
  kind       TEXT    NOT NULL,
  succeeded  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX auth_attempts_ip_kind_created_idx ON auth_attempts(ip, kind, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log —— 管理员操作记录。小、只追加、保留成本低。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT    NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);
