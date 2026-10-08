-- MySQL 8.4 版迁移（自 packages/db/migrations/0002_plugins.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

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
ALTER TABLE users ADD COLUMN signature VARCHAR(4096) NOT NULL DEFAULT '';

-- OAuth 账号绑定。一个用户可绑定多个 provider；一个 provider openid 只能绑一个用户。
CREATE TABLE user_identities (
  provider         VARCHAR(64)  NOT NULL,
  provider_user_id VARCHAR(512) NOT NULL,
  user_id          BIGINT       NOT NULL,
  created_at       BIGINT       NOT NULL,
  PRIMARY KEY (provider, provider_user_id),
  CONSTRAINT user_identities_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

-- 正版验证绑定（Microsoft→Xbox→Minecraft 链验证成功后写入）
CREATE TABLE mojang_verifications (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id    BIGINT NOT NULL,
  uuid       VARCHAR(64) NOT NULL,
  verified   BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  UNIQUE KEY mojang_verifications_user_unique (user_id),
  UNIQUE KEY mojang_verifications_uuid_unique (uuid),
  CONSTRAINT mojang_verifications_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 角色名 ↔ UUID 映射（uuid 算法 v3 时改名保留 UUID；Mojang 同步也写这里）
-- name 参与主键索引，VARCHAR(64) 在 utf8mb4 下远小于 3072 字节索引上限。
CREATE TABLE uuid (
  name VARCHAR(64)  PRIMARY KEY,
  uuid VARCHAR(64)  NOT NULL,
  UNIQUE KEY uuid_value_unique (uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Yggdrasil 请求日志
CREATE TABLE ygg_log (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  ip         VARCHAR(64),
  action     VARCHAR(128) NOT NULL,
  body       TEXT,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX ygg_log_created_idx ON ygg_log (created_at);

-- 纹理描述（texture-description 插件语义：tid 唯一）
CREATE TABLE textures_description (
  tid         BIGINT PRIMARY KEY,
  description TEXT NOT NULL,
  updated_at  BIGINT NOT NULL,
  CONSTRAINT textures_description_tid_fk FOREIGN KEY (tid) REFERENCES textures(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 评论区（原生模块）。comments_ai_moderation 开启时 status 初始为 pending/published 由审核结果决定
CREATE TABLE comments (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  texture_id BIGINT NOT NULL,
  user_id    BIGINT,
  user_name  VARCHAR(512) NOT NULL DEFAULT '',
  content    TEXT   NOT NULL,
  status     VARCHAR(32) NOT NULL DEFAULT 'published',
  ai_flagged BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  CONSTRAINT comments_texture_fk FOREIGN KEY (texture_id) REFERENCES textures(id) ON DELETE CASCADE,
  CONSTRAINT comments_user_fk    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX comments_texture_idx ON comments (texture_id, created_at);
CREATE INDEX comments_status_idx ON comments (status, created_at);

-- Yggdrasil 令牌（id = sha256(accessToken)；原始 JWT 只在响应里出现一次）
CREATE TABLE ygg_tokens (
  id               VARCHAR(128) PRIMARY KEY,
  user_id          BIGINT NOT NULL,
  client_token     VARCHAR(128) NOT NULL,
  created_at       BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  refresh_deadline BIGINT NOT NULL,
  CONSTRAINT ygg_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX ygg_tokens_user_idx ON ygg_tokens (user_id);
