CREATE TABLE pigeon_api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  usage_count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pigeon_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  server_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE pigeon_votes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'closed', 'cancelled')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  max_choices INTEGER NOT NULL CHECK (max_choices >= 1),
  results_policy TEXT NOT NULL CHECK (results_policy IN ('after_close', 'after_vote', 'always')),
  registered_before INTEGER,
  min_score INTEGER NOT NULL DEFAULT 0,
  require_verified INTEGER NOT NULL DEFAULT 0,
  play_rules TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  archived_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  mutation_key TEXT,
  review_required INTEGER NOT NULL DEFAULT 0,
  review_notes TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX pigeon_votes_window ON pigeon_votes(status, archived_at, starts_at, ends_at);
CREATE TABLE pigeon_vote_options (
  id TEXT PRIMARY KEY,
  vote_id TEXT NOT NULL REFERENCES pigeon_votes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  UNIQUE(vote_id, position)
);
CREATE TABLE pigeon_ballots (
  id TEXT PRIMARY KEY,
  vote_id TEXT NOT NULL REFERENCES pigeon_votes(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voter_name TEXT NOT NULL,
  option_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(vote_id, user_id)
);
CREATE INDEX pigeon_ballots_vote ON pigeon_ballots(vote_id, updated_at);
CREATE TRIGGER pigeon_ballot_choices_immutable BEFORE UPDATE OF option_ids, vote_id ON pigeon_ballots
BEGIN
  SELECT RAISE(ABORT, 'ballot_immutable');
END;
CREATE TABLE pigeon_ballot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ballot_id TEXT NOT NULL REFERENCES pigeon_ballots(id) ON DELETE CASCADE,
  option_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  UNIQUE(ballot_id, revision)
);
CREATE TABLE pigeon_legacy_archive (
  source_table TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (source_table, legacy_id)
) WITHOUT ROWID;
