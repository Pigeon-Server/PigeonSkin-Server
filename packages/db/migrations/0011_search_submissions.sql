CREATE TABLE search_submissions (
  engine TEXT NOT NULL CHECK (engine IN ('google', 'bing', 'baidu')),
  texture_id INTEGER NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  http_status INTEGER,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (engine, texture_id)
);
CREATE INDEX search_submissions_due_idx ON search_submissions(status, next_at);
