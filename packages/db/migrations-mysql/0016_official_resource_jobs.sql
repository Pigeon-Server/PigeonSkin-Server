-- MySQL 8.4 版迁移（自 packages/db/migrations/0016_official_resource_jobs.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

ALTER TABLE official_resource_sync ADD COLUMN phase VARCHAR(32) NOT NULL DEFAULT 'idle';

CREATE TABLE official_resource_batches (
  job_id    VARCHAR(128) NOT NULL,
  batch_key VARCHAR(512) NOT NULL,
  added     BIGINT NOT NULL,
  updated   BIGINT NOT NULL,
  PRIMARY KEY (job_id, batch_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
