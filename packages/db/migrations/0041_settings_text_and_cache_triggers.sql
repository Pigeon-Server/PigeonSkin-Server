-- 性能改造收尾：缓存版本触发器的写放大、大文本列上限、冗余索引。
--
-- 1) textures_cache_update 原本 AFTER UPDATE 无条件 bump 'textures' 版本。
--    首页/材质列表属于含 textures 的 strict 作用域，于是每次点赞（likes+1）、
--    每次净化标记都会让整站公开目录缓存失效并触发一次 KV 重发布 ——
--    与「降低 D1 读放大」的目标相反。收窄到真正影响展示的列。
-- 2) settings_snapshots.value / settings.value 需要容纳 custom_css、custom_js、
--    多语言提示词等长文本（单 locale 快照是这些值的聚合 JSON）。
-- 3) 0032 引入的新索引与旧索引存在严格前缀冗余，旧索引未删会放大每次写入。

-- ── 1. 收窄缓存版本触发器（只在这些列变化时失效公开目录）──────────────────
DROP TRIGGER IF EXISTS textures_cache_update;
CREATE TRIGGER textures_cache_update AFTER UPDATE OF visibility,kind,model,name,uploader_id,hash,official_key,width,height,size_bytes,created_at ON textures BEGIN
  UPDATE public_cache_versions SET version=version+1 WHERE scope='textures';
END;

-- ── 2. 冗余索引清理（新索引已完全覆盖其前缀）──────────────────────────────
DROP INDEX IF EXISTS textures_vis_created_idx;
DROP INDEX IF EXISTS textures_vis_likes_idx;
DROP INDEX IF EXISTS textures_hash_idx;

-- ── 3. 大文本列：快照与设置值都可能超过 TEXT 的 64 KiB ────────────────────
-- SQLite 的 TEXT 本身无长度限制，无需变更。
