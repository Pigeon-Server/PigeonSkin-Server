ALTER TABLE official_resource_sync ADD COLUMN phase TEXT NOT NULL DEFAULT 'idle';
CREATE TABLE official_resource_batches (
  job_id TEXT NOT NULL,
  batch_key TEXT NOT NULL,
  added INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (job_id,batch_key)
);
