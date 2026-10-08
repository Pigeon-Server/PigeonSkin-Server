-- MySQL 8.4 版迁移（自 packages/db/migrations/0019_tickets.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

CREATE TABLE tickets (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  ticket_number      VARCHAR(64) NOT NULL,
  user_id            BIGINT NOT NULL,
  title              VARCHAR(4096) NOT NULL,
  category           VARCHAR(64) NOT NULL,
  description        TEXT NOT NULL,
  status             VARCHAR(32) NOT NULL DEFAULT 'pending',
  last_user_read_at  BIGINT,
  last_admin_read_at BIGINT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  closed_at          BIGINT,
  UNIQUE KEY tickets_number_unique (ticket_number),
  CONSTRAINT tickets_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX tickets_user_updated ON tickets(user_id, updated_at DESC);
CREATE INDEX tickets_status_updated ON tickets(status, updated_at DESC);

CREATE TABLE ticket_messages (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  ticket_id   BIGINT NOT NULL,
  author_id   BIGINT,
  author_type VARCHAR(32) NOT NULL,
  body        TEXT NOT NULL,
  internal    BIGINT NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL,
  CONSTRAINT ticket_messages_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT ticket_messages_author_fk FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX ticket_messages_ticket_created ON ticket_messages(ticket_id, created_at);

CREATE TABLE ticket_attachments (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  ticket_id   BIGINT NOT NULL,
  message_id  BIGINT,
  object_key  VARCHAR(512) NOT NULL,
  file_name   VARCHAR(1024) NOT NULL,
  mime_type   VARCHAR(128) NOT NULL,
  size_bytes  BIGINT NOT NULL,
  created_at  BIGINT NOT NULL,
  UNIQUE KEY ticket_attachments_object_key_unique (object_key),
  CONSTRAINT ticket_attachments_ticket_fk  FOREIGN KEY (ticket_id)  REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT ticket_attachments_message_fk FOREIGN KEY (message_id) REFERENCES ticket_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX ticket_attachments_ticket ON ticket_attachments(ticket_id);

CREATE TABLE ticket_events (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  ticket_id  BIGINT NOT NULL,
  actor_id   BIGINT,
  type       VARCHAR(64) NOT NULL,
  from_status VARCHAR(32),
  to_status  VARCHAR(32),
  detail     TEXT,
  created_at BIGINT NOT NULL,
  CONSTRAINT ticket_events_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  CONSTRAINT ticket_events_actor_fk  FOREIGN KEY (actor_id)  REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX ticket_events_ticket_created ON ticket_events(ticket_id, created_at);
