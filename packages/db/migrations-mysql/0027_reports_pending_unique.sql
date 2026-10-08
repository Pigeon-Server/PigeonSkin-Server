-- 举报去重的最终保证必须落在数据库约束上：应用层的条件插入
-- （INSERT ... SELECT ... WHERE NOT EXISTS）在读写并发下并不原子 ——
-- 重复行会按条发放举报奖励。MySQL 没有部分索引，用表达式唯一索引表达
-- 同一语义：只有 status='pending' 的行参与唯一性，NULL（已处理的行）不参与，
-- 因此处理完成（resolved/rejected）后仍可重新举报，
-- 0026 建的 reports_reporter_idx 保留用于外键支撑与按举报人过滤。
--
-- 建索引前先清理竞态已经产生的重复 pending（保留最早一条，与账号合并
-- 等既有迁移工具的去重语义一致）；清理后不可能再有重复，索引必然建成。
-- 子查询包一层派生表是 MySQL 限制：DELETE 的目标表不能直接出现在子查询里。
DELETE FROM reports
 WHERE status = 'pending'
   AND id NOT IN (SELECT keep_id FROM (SELECT MIN(id) AS keep_id FROM reports WHERE status = 'pending' GROUP BY reporter_id, texture_id) AS keep);

CREATE UNIQUE INDEX reports_pending_unique ON reports ((IF(status = 'pending', CONCAT(reporter_id, ':', texture_id), NULL)));
