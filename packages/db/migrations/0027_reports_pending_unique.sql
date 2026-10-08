-- 举报去重的最终保证必须落在数据库约束上：应用层的条件插入
-- （INSERT ... SELECT ... WHERE NOT EXISTS）在读写并发下并不原子 ——
-- PostgreSQL READ COMMITTED 实测 60 个并发请求能写入 46 条重复 pending，
-- 重复行会按条发放举报奖励。部分唯一索引只约束 pending 行，
-- 处理完成（resolved/rejected）后仍可重新举报，0026 建的 reports_reporter_idx
-- 保留用于外键支撑与按举报人过滤。
--
-- 建索引前先清理竞态已经产生的重复 pending（保留最早一条，与账号合并
-- 等既有迁移工具的去重语义一致）；清理后不可能再有重复，索引必然建成。
DELETE FROM reports
 WHERE status = 'pending'
   AND id NOT IN (SELECT MIN(id) FROM reports WHERE status = 'pending' GROUP BY reporter_id, texture_id);

CREATE UNIQUE INDEX reports_pending_unique ON reports(reporter_id, texture_id) WHERE status = 'pending';
