-- uuid_archive 的一致约束（见 sqlite 版说明）。ctid 在 UPDATE 前是行的物理位置，
-- 每组按它取最早一行。
DELETE FROM uuid_archive a
USING uuid_archive b
WHERE a.ctid > b.ctid AND lower(a.name) = lower(b.name);

DELETE FROM uuid_archive a
USING uuid_archive b
WHERE a.ctid > b.ctid AND a.uuid = b.uuid;

CREATE UNIQUE INDEX uuid_archive_name_unique ON uuid_archive (lower(name));
CREATE UNIQUE INDEX uuid_archive_uuid_unique ON uuid_archive (uuid);
