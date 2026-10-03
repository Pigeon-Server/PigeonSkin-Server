-- 插件内置化 + 后台补齐（2026-09-30）
--
-- 新增：
--   users.signature            个人签名（用户资料）
--   user_identities            OAuth 账号绑定（provider + openid → user）
--   mojang_verifications       正版验证绑定（mojang-verification 插件语义）
--   uuid                       角色名 ↔ 离线 UUID 映射（yggdrasil-api）
--   ygg_log                    Yggdrasil 请求日志
--   textures_description       纹理 Markdown 描述（texture-description 插件语义）
--   comments                   皮肤/材质评论区（原生模块）
--   ygg_tokens                 Yggdrasil accessToken（sha256 落库，JWT 载荷不敏感）

-- 用户个人签名
ALTER TABLE users ADD COLUMN signature TEXT NOT NULL DEFAULT '';

-- OAuth 账号绑定。一个用户可绑定多个 provider；一个 provider openid 只能绑一个用户。
CREATE TABLE user_identities (
  provider         TEXT    NOT NULL,
  provider_user_id TEXT    NOT NULL,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- 正版验证绑定（Microsoft→Xbox→Minecraft 链验证成功后写入）
CREATE TABLE mojang_verifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  uuid       TEXT    NOT NULL UNIQUE,
  verified   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 角色名 ↔ UUID 映射（uuid 算法 v3 时改名保留 UUID；Mojang 同步也写这里）
CREATE TABLE uuid (
  name TEXT PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE
);

-- Yggdrasil 请求日志
CREATE TABLE ygg_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT,
  action     TEXT    NOT NULL,
  body       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ygg_log_created_idx ON ygg_log (created_at);

-- 纹理描述（texture-description 插件语义：tid 唯一）
CREATE TABLE textures_description (
  tid         INTEGER PRIMARY KEY REFERENCES textures(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

-- 评论区（原生模块）。comments_ai_moderation 开启时 status 初始为 pending/published 由审核结果决定
CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  texture_id INTEGER NOT NULL REFERENCES textures(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'published',
  ai_flagged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_texture_idx ON comments (texture_id, created_at);
CREATE INDEX comments_status_idx ON comments (status, created_at);

-- Yggdrasil 令牌（id = sha256(accessToken)；原始 JWT 只在响应里出现一次）
CREATE TABLE ygg_tokens (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_token TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  refresh_deadline INTEGER NOT NULL
);
CREATE INDEX ygg_tokens_user_idx ON ygg_tokens (user_id);
