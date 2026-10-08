-- AI 网关后台任务与材质翻译/审核。
--
-- ai_jobs：AI 任务队列的唯一事实源。cron/入队路径按 (status, next_run_at)
-- 认领到期任务；(kind, tid) 唯一 —— 重复入队等于重置（材质编辑后重跑）。
-- task_runs：每小时定时任务（cleanup/官方资源同步/sitemap）的运行记录，
-- 供管理员后台任务页展示。
-- texture_translations：材质名/简介的 AI 译文，按 (tid, locale) 存储，
-- 展示时 LEFT JOIN 覆盖原文，无译文回退原文。
-- textures 加 AI 审核标记列：违规内容照常展示，由管理员人工处置。

CREATE TABLE ai_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('translate_texture', 'moderate_texture_name', 'moderate_texture_description')),
  tid INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX ai_jobs_kind_tid_idx ON ai_jobs(kind, tid);
CREATE INDEX ai_jobs_due_idx ON ai_jobs(status, next_run_at);

CREATE TABLE task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ran_at INTEGER NOT NULL
);

CREATE INDEX task_runs_name_ran_idx ON task_runs(name, ran_at DESC);

CREATE TABLE texture_translations (
  tid INTEGER NOT NULL REFERENCES textures(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tid, locale)
);

ALTER TABLE textures ADD COLUMN name_flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE textures ADD COLUMN name_flag_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE textures ADD COLUMN description_flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE textures ADD COLUMN description_flag_reason TEXT NOT NULL DEFAULT '';
