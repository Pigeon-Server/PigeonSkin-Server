-- 站内信 AI 翻译。
--
-- notification_translations：站点公告（site_message）的 AI 译文骨架，按
-- (content_hash, locale) 寻址 —— content_hash 是「模板骨架」（管理员写的
-- 原文，变量未渲染）的哈希，同一模板群发给 N 个用户共享一份译文；模板
-- 改动后哈希变化，旧译文自动失效。source_title / source_body 保存骨架
-- 原文：入队时写入（locale='' 哨兵行，译文列为空），执行器据此调用 AI
-- 并按 locale 回填译文；读取方按行上的 template_hash 匹配后自行渲染变量。
-- ai_jobs 的 CHECK 约束按 SQLite 限制无法 ALTER，新 kind 直接放宽为新表
-- 时代的全集（本迁移重建 ai_jobs）。

CREATE TABLE notification_translations (
  content_hash TEXT NOT NULL,
  locale TEXT NOT NULL,
  source_title TEXT NOT NULL DEFAULT '',
  source_body TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (content_hash, locale)
);

CREATE TABLE ai_jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('translate_texture', 'moderate_texture_name', 'moderate_texture_description', 'translate_notification')),
  tid INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO ai_jobs_new (id, kind, tid, status, attempts, next_run_at, last_error, created_at, updated_at)
  SELECT id, kind, tid, status, attempts, next_run_at, last_error, created_at, updated_at FROM ai_jobs;

DROP TABLE ai_jobs;
ALTER TABLE ai_jobs_new RENAME TO ai_jobs;

CREATE UNIQUE INDEX ai_jobs_kind_tid_idx ON ai_jobs(kind, tid);
CREATE INDEX ai_jobs_due_idx ON ai_jobs(status, next_run_at);

-- 通知行记录其模板骨架哈希:渲染后的文本因人而异,无法反推骨架;
-- 读取端按行上的哈希直接匹配译文。非翻译通知为空串。
ALTER TABLE notifications ADD COLUMN template_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX notifications_template_hash_idx ON notifications(template_hash) WHERE template_hash != '';
