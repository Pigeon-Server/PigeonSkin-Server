-- uuid_archive 的一致约束。
--
-- 归档表保存「已删除角色的名字 → UUID」，同名最多保留一条：uuidForPlayer 复用
-- 归档时按名字取，若同名多行并存，取回哪个取决于扫描顺序，启动器记住的
-- profileID 就可能拿不到。迁移前的历史数据里可能已有同名重复，先清理再建索引。
DELETE FROM uuid_archive
WHERE rowid NOT IN (SELECT MIN(rowid) FROM uuid_archive GROUP BY lower(name));

-- 「同 uuid 挂两个名字」同样会让唯一索引建不起来（归档守卫落地前的中间版本可能产生），
-- 保留最早一行
DELETE FROM uuid_archive
WHERE rowid NOT IN (SELECT MIN(rowid) FROM uuid_archive GROUP BY uuid);

CREATE UNIQUE INDEX uuid_archive_name_unique ON uuid_archive (name COLLATE NOCASE);
CREATE UNIQUE INDEX uuid_archive_uuid_unique ON uuid_archive (uuid);
