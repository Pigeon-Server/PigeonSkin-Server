-- MySQL 版迁移（自 packages/db/migrations/0028_notification_translations.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- 注意：本目录此前缺失 0024（ai_jobs / task_runs / texture_translations），
-- 在此一并补齐 —— 0028 要放宽 ai_jobs 的 kind ENUM，必须先有 0024 的表。
-- 已手工建过的部署记账后跳过（CREATE TABLE IF NOT EXISTS 幂等）。

-- ── 0024（补齐）─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_runs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  ok BIGINT NOT NULL,
  detail TEXT NOT NULL,
  ran_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX task_runs_name_ran_idx ON task_runs(name, ran_at DESC);

CREATE TABLE IF NOT EXISTS texture_translations (
  tid BIGINT NOT NULL,
  locale VARCHAR(16) NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tid, locale),
  CONSTRAINT texture_translations_tid_foreign FOREIGN KEY (tid) REFERENCES textures (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ai_jobs 首次创建即为包含 translate_notification 的 ENUM 全集；
-- 已建旧 ENUM 的库由下方 0028 段的 ALTER TABLE MODIFY 放宽。
CREATE TABLE IF NOT EXISTS ai_jobs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  kind ENUM('translate_texture', 'moderate_texture_name', 'moderate_texture_description', 'translate_notification') NOT NULL,
  tid BIGINT NOT NULL,
  status ENUM('pending', 'processing', 'done', 'failed', 'cancelled') NOT NULL DEFAULT 'pending',
  attempts BIGINT NOT NULL DEFAULT 0,
  next_run_at BIGINT NOT NULL,
  last_error TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT ai_jobs_kind_tid_unique UNIQUE (kind, tid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX ai_jobs_due_idx ON ai_jobs(status, next_run_at);

-- ── 0028（本迁移）───────────────────────────────────────────────────────────

-- 主键 (content_hash, locale)：译文按模板骨架寻址，与具体通知行无关。
-- content_hash 存 uint32 十进制字符串，最长 10 位，VARCHAR(16) 留余量。
CREATE TABLE IF NOT EXISTS notification_translations (
  content_hash VARCHAR(16) NOT NULL,
  locale VARCHAR(16) NOT NULL,
  source_title VARCHAR(512) NOT NULL DEFAULT '',
  source_body MEDIUMTEXT NOT NULL,
  title VARCHAR(512) NOT NULL DEFAULT '',
  body MEDIUMTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (content_hash, locale)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 历史旧 ENUM 库放宽 kind；新库已是全集，MODIFY 幂等。
ALTER TABLE ai_jobs MODIFY COLUMN kind ENUM('translate_texture', 'moderate_texture_name', 'moderate_texture_description', 'translate_notification') NOT NULL;

ALTER TABLE notifications ADD COLUMN template_hash VARCHAR(16) NOT NULL DEFAULT '';
CREATE INDEX notifications_template_hash_idx ON notifications(template_hash);
