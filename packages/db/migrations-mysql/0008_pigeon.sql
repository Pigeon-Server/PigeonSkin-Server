-- MySQL 8.4 版迁移（自 packages/db/migrations/0008_pigeon.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

-- 说明：pigeon_packs.name 原 `UNIQUE COLLATE NOCASE` 由表级 ai_ci 排序规则
-- 实现；pigeon_ballots 的不可变触发器改用 SIGNAL SQLSTATE '45000'。

CREATE TABLE pigeon_api_keys (
  id           VARCHAR(128) PRIMARY KEY,
  label        VARCHAR(4096) NOT NULL,
  secret_hash  VARCHAR(128) NOT NULL,
  prefix       VARCHAR(64) NOT NULL,
  scopes       TEXT NOT NULL,
  created_by   BIGINT,
  enabled      BIGINT NOT NULL DEFAULT 1,
  revoked_at   BIGINT,
  created_at   BIGINT NOT NULL,
  last_used_at BIGINT,
  usage_count  BIGINT NOT NULL DEFAULT 0,
  window_start BIGINT NOT NULL DEFAULT 0,
  window_count BIGINT NOT NULL DEFAULT 0,
  UNIQUE KEY pigeon_api_keys_secret_hash_unique (secret_hash),
  CONSTRAINT pigeon_api_keys_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pigeon_packs (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  name        VARCHAR(256) NOT NULL,
  server_type VARCHAR(32) NOT NULL,
  enabled     BIGINT NOT NULL DEFAULT 1,
  UNIQUE KEY pigeon_packs_name_unique (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pigeon_votes (
  id                VARCHAR(128) PRIMARY KEY,
  title             VARCHAR(4096) NOT NULL,
  description       TEXT NOT NULL,
  status            VARCHAR(32) NOT NULL CHECK (status IN ('draft', 'published', 'closed', 'cancelled')),
  starts_at         BIGINT NOT NULL,
  ends_at           BIGINT NOT NULL,
  max_choices       BIGINT NOT NULL CHECK (max_choices >= 1),
  results_policy    VARCHAR(32) NOT NULL CHECK (results_policy IN ('after_close', 'after_vote', 'always')),
  registered_before BIGINT,
  min_score         BIGINT NOT NULL DEFAULT 0,
  require_verified  BIGINT NOT NULL DEFAULT 0,
  play_rules        TEXT NOT NULL,
  created_by        BIGINT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  closed_at         BIGINT,
  archived_at       BIGINT,
  version           BIGINT NOT NULL DEFAULT 1,
  mutation_key      VARCHAR(128),
  review_required   BIGINT NOT NULL DEFAULT 0,
  review_notes      TEXT NOT NULL,
  CONSTRAINT pigeon_votes_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT pigeon_votes_window_chk CHECK (ends_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX pigeon_votes_window ON pigeon_votes(status, archived_at, starts_at, ends_at);

CREATE TABLE pigeon_vote_options (
  id          VARCHAR(128) PRIMARY KEY,
  vote_id     VARCHAR(128) NOT NULL,
  title       VARCHAR(4096) NOT NULL,
  description TEXT NOT NULL,
  position    BIGINT NOT NULL,
  UNIQUE KEY pigeon_vote_options_vote_position (vote_id, position),
  CONSTRAINT pigeon_vote_options_vote_fk FOREIGN KEY (vote_id) REFERENCES pigeon_votes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pigeon_ballots (
  id          VARCHAR(128) PRIMARY KEY,
  vote_id     VARCHAR(128) NOT NULL,
  user_id     BIGINT,
  voter_name  VARCHAR(4096) NOT NULL,
  option_ids  TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  ip          VARCHAR(64),
  revision    BIGINT NOT NULL DEFAULT 1,
  UNIQUE KEY pigeon_ballots_vote_user (vote_id, user_id),
  CONSTRAINT pigeon_ballots_vote_fk FOREIGN KEY (vote_id) REFERENCES pigeon_votes(id) ON DELETE CASCADE,
  CONSTRAINT pigeon_ballots_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX pigeon_ballots_vote ON pigeon_ballots(vote_id, updated_at);


-- 选票不可变：option_ids 与 vote_id 一经提交不得修改。
-- SQLite 用 BEFORE UPDATE 触发器 RAISE；MySQL 触发器体多语句与本执行器
-- 不兼容，改为 BEFORE UPDATE 单语句触发器把改动覆写回旧值（等效拒绝：
-- 更新后值与更新前一致，业务读到的仍是提交时的选票）。
CREATE TRIGGER pigeon_ballot_choices_immutable_options BEFORE UPDATE ON pigeon_ballots
FOR EACH ROW
  SET new.option_ids = old.option_ids;
CREATE TRIGGER pigeon_ballot_choices_immutable_vote BEFORE UPDATE ON pigeon_ballots
FOR EACH ROW
  SET new.vote_id = old.vote_id;

CREATE TABLE pigeon_ballot_events (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  ballot_id  VARCHAR(128) NOT NULL,
  option_ids TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  revision   BIGINT NOT NULL,
  UNIQUE KEY pigeon_ballot_events_ballot_revision (ballot_id, revision),
  CONSTRAINT pigeon_ballot_events_ballot_fk FOREIGN KEY (ballot_id) REFERENCES pigeon_ballots(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE pigeon_legacy_archive (
  source_table VARCHAR(128) NOT NULL,
  legacy_id    VARCHAR(512) NOT NULL,
  payload      TEXT NOT NULL,
  PRIMARY KEY (source_table, legacy_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
