-- MySQL 8.4 版迁移（自 packages/db/migrations/0020_ticket_categories.sql 翻译）。
-- 由 Node 迁移执行器应用；D1 路径不使用本目录。

CREATE TABLE ticket_categories (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  slug       VARCHAR(128) NOT NULL,
  name       VARCHAR(256) NOT NULL,
  hidden     BIGINT NOT NULL DEFAULT 0,
  sort_order BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE KEY ticket_categories_slug_unique (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE tickets ADD COLUMN category_id BIGINT, ADD CONSTRAINT tickets_category_fk FOREIGN KEY (category_id) REFERENCES ticket_categories(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN category_name VARCHAR(256) NOT NULL DEFAULT '';
CREATE INDEX ticket_categories_visible ON ticket_categories(hidden, sort_order, id);
CREATE INDEX tickets_category_id ON tickets(category_id);

INSERT INTO ticket_categories(slug,name,hidden,sort_order,created_at,updated_at)
VALUES
  ('account', '账号与安全', 0, 10, (UNIX_TIMESTAMP() * 1000), (UNIX_TIMESTAMP() * 1000)),
  ('texture', '皮肤与材质', 0, 20, (UNIX_TIMESTAMP() * 1000), (UNIX_TIMESTAMP() * 1000)),
  ('site', '站点功能', 0, 30, (UNIX_TIMESTAMP() * 1000), (UNIX_TIMESTAMP() * 1000)),
  ('other', '其他', 0, 100, (UNIX_TIMESTAMP() * 1000), (UNIX_TIMESTAMP() * 1000));

UPDATE tickets
SET category_id = (SELECT id FROM ticket_categories WHERE ticket_categories.slug = tickets.category),
    category_name = COALESCE((SELECT name FROM ticket_categories WHERE ticket_categories.slug = tickets.category), tickets.category)
WHERE category_name = '';
