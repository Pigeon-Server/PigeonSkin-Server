-- MySQL 8.4 版迁移（自 packages/db/migrations/0012_legacy_account_conflicts.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- 方言差异说明：
--   • SQLite 版此处将 users_email_unique 重建为部分唯一索引
--     （WHERE legacy_email_conflict = 0）。MySQL 不支持部分索引，等价改写：
--     生成列 email_unique_slot 在 legacy_email_conflict = 0 时取 email 内容、
--     其余取 NULL，唯一索引建在其上 —— NULL 不参与唯一约束，冲突账号豁免，
--     语义与部分唯一索引一致（0013 的触发器随之冗余，改为空操作说明）。
--   • ai_ci 排序规则本身大小写不敏感，COLLATE NOCASE 去除。

ALTER TABLE users ADD COLUMN legacy_email_conflict BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN merged_into_user_id BIGINT, ADD CONSTRAINT users_merged_into_fk FOREIGN KEY (merged_into_user_id) REFERENCES users(id);

DROP INDEX users_email_unique ON users;
ALTER TABLE users ADD COLUMN email_unique_slot VARCHAR(512) GENERATED ALWAYS AS (IF(legacy_email_conflict = 0, email, NULL)) STORED;
CREATE UNIQUE INDEX users_email_unique ON users(email_unique_slot);

CREATE TABLE legacy_account_merges (
  id               VARCHAR(128) PRIMARY KEY,
  email            VARCHAR(512)  NOT NULL,
  retained_user_id BIGINT NOT NULL,
  merged_user_ids  TEXT NOT NULL,
  archived_data    TEXT NOT NULL,
  created_at       BIGINT NOT NULL,
  UNIQUE KEY legacy_account_merges_email_unique (email),
  CONSTRAINT legacy_account_merges_retained_fk FOREIGN KEY (retained_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
