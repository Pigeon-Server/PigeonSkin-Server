-- 举报去重语义调整为「处理完成前不允许重复举报」后，旧的
-- (reporter_id, texture_id) 唯一索引会在举报处理完成后继续阻止再次举报。
-- 这里把它换成普通索引，去重的最终约束由 0027 的部分唯一索引承担
-- （只锁 pending 行），reports_reporter_idx 保留用于外键支撑与按举报人过滤。
--
-- 唯一索引仍定义在 0000_init.sql 中（fresh 库先建后删，与既有库走同一路径）。
-- 替代索引必须先建再删：MySQL 会自动丢弃与显式索引重叠的外键自动索引，
-- 因此 reporter_id 上的 reports_reporter_fk 实际由该唯一索引承担，直接删会报
-- "Cannot drop index 'reports_reporter_texture_unique': needed in a foreign key
-- constraint"（实测）。必须先建替代索引，让外键有索引可用，再删唯一索引。
CREATE INDEX IF NOT EXISTS reports_reporter_idx ON reports(reporter_id);
DROP INDEX IF EXISTS reports_reporter_texture_unique;
