-- 改名时清除 uuid_archive 中新名字的残留映射。
--
-- 对齐上游 blessing-skin-plugins/yggdrasil-api 的 v4 改名回调语义：
--   DB::table('uuid')->where('name', $new)->delete();
--   DB::table('uuid')->where('name', $original)->update(['name' => $new]);
-- uuid 表的行已由 uuid_player_renamed 触发器跟随改名；uuid_archive 是
-- 「名字 → 已删除角色 UUID」的常驻映射，新名字被活角色占用后其死映射必须
-- 让位，否则之后删掉这个角色再同名重建时，会复用到启动器从未见过的旧 UUID。
CREATE TRIGGER uuid_player_renamed_purge_archive AFTER UPDATE OF name ON players WHEN NEW.name IS NOT OLD.name
BEGIN
  DELETE FROM uuid_archive WHERE name = NEW.name COLLATE NOCASE;
END;
