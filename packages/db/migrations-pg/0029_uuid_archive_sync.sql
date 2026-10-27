-- 改名时清除 uuid_archive 中新名字的残留映射（对齐上游 yggdrasil-api v4
-- 改名回调：先删新名字的映射，再把旧行改名过来）。uuid 表的行已由
-- uuid_player_renamed 触发器跟随改名；uuid_archive 是「名字 → 已删除角色
-- UUID」的常驻映射，新名字被活角色占用后其死映射必须让位。
CREATE FUNCTION uuid_player_renamed_purge_archive_fn() RETURNS trigger AS $$
BEGIN
  DELETE FROM uuid_archive WHERE lower(name) = lower(NEW.name);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER uuid_player_renamed_purge_archive AFTER UPDATE OF name ON players
FOR EACH ROW WHEN (NEW.name IS DISTINCT FROM OLD.name)
EXECUTE FUNCTION uuid_player_renamed_purge_archive_fn();
