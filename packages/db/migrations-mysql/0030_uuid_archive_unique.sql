-- uuid_archive 的一致约束（见 sqlite 版说明）。
-- MySQL 8 不支持「删除组内非最小值」的自连接写法：`a.uuid <> b.uuid` 会把
-- 同名不同 uuid 的整组删光，且删不掉完全重复的行。改为用窗口函数落一份
-- 去重表再替换（uuid_archive 由 0006 的 CTAS 建立，没有主键可依赖）。
--
-- 两轮去重：先按名字（同名最多一条），再按 uuid（同一 UUID 只能挂一个名字），
-- 第二轮用 `uuid` 排序而不是再次按名字，避免把刚保留的行删掉。
CREATE TABLE uuid_archive_dedup AS
SELECT name, uuid FROM (
  SELECT name, uuid, ROW_NUMBER() OVER (
    PARTITION BY lower(name) ORDER BY uuid
  ) AS rn
  FROM uuid_archive
) ranked
WHERE rn = 1;

DELETE FROM uuid_archive;
INSERT INTO uuid_archive (name, uuid) SELECT name, uuid FROM uuid_archive_dedup;
DROP TABLE uuid_archive_dedup;

CREATE TABLE uuid_archive_uuid_dedup AS
SELECT name, uuid FROM (
  SELECT name, uuid, ROW_NUMBER() OVER (
    PARTITION BY uuid ORDER BY lower(name)
  ) AS rn
  FROM uuid_archive
) ranked
WHERE rn = 1;

DELETE FROM uuid_archive;
INSERT INTO uuid_archive (name, uuid) SELECT name, uuid FROM uuid_archive_uuid_dedup;
DROP TABLE uuid_archive_uuid_dedup;

CREATE UNIQUE INDEX uuid_archive_name_unique ON uuid_archive (name);
CREATE UNIQUE INDEX uuid_archive_uuid_unique ON uuid_archive (uuid);
