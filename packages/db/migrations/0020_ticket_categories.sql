CREATE TABLE ticket_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE tickets ADD COLUMN category_id INTEGER REFERENCES ticket_categories(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN category_name TEXT NOT NULL DEFAULT '';
CREATE INDEX ticket_categories_visible ON ticket_categories(hidden, sort_order, id);
CREATE INDEX tickets_category_id ON tickets(category_id);

INSERT INTO ticket_categories(slug,name,hidden,sort_order,created_at,updated_at)
VALUES
  ('account', '账号与安全', 0, 10, unixepoch() * 1000, unixepoch() * 1000),
  ('texture', '皮肤与材质', 0, 20, unixepoch() * 1000, unixepoch() * 1000),
  ('site', '站点功能', 0, 30, unixepoch() * 1000, unixepoch() * 1000),
  ('other', '其他', 0, 100, unixepoch() * 1000, unixepoch() * 1000);

UPDATE tickets
SET category_id = (SELECT id FROM ticket_categories WHERE ticket_categories.slug = tickets.category),
    category_name = COALESCE((SELECT name FROM ticket_categories WHERE ticket_categories.slug = tickets.category), tickets.category)
WHERE category_name = '';
