ALTER TABLE users ADD COLUMN legacy_email_conflict INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN merged_into_user_id INTEGER REFERENCES users(id);
DROP INDEX users_email_unique;
CREATE UNIQUE INDEX users_email_unique ON users(email COLLATE NOCASE) WHERE legacy_email_conflict = 0;
CREATE TABLE legacy_account_merges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  retained_user_id INTEGER NOT NULL REFERENCES users(id),
  merged_user_ids TEXT NOT NULL,
  archived_data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
