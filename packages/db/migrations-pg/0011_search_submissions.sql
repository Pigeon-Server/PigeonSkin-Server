-- PostgreSQL 版迁移（自 packages/db/migrations/0011_search_submissions.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

CREATE TABLE search_submissions (
  engine TEXT NOT NULL CHECK (engine IN ('google', 'bing', 'baidu')),
  texture_id BIGINT NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'failed')),
  attempts BIGINT NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL,
  http_status BIGINT,
  error TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (engine, texture_id)
);
CREATE INDEX search_submissions_due_idx ON search_submissions(status, next_at);
