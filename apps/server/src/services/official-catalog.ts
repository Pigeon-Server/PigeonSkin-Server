import type { Bindings } from '../env.ts';
import { scalarMax } from '@pigeon-skin/db';
import { textureObjectKey } from '@pigeon-skin/minecraft';
import { OFFICIAL_CATALOG_REVISION as revision } from '@pigeon-skin/shared/official-textures';

async function initialize(env: Pick<Bindings, 'DB' | 'BUCKET'>) {
  const current = await env.DB.prepare('SELECT revision FROM official_catalog_state WHERE id = 1').first<{ revision: number }>();
  const { officialTextures } = await import('@pigeon-skin/shared/official-textures');
  // 状态表声称已导入还不够：整库重导等运维操作可能只保留状态行而丢掉官方材质行，
  // 这里按 key 集合兜底，缺行时重建（INSERT OR IGNORE 只补缺失行，已有行不受影响）。
  if (current && current.revision >= revision) {
    const rows = await env.DB.prepare('SELECT official_key FROM textures WHERE official_key IS NOT NULL').all<{ official_key: string }>();
    const present = new Set(rows.results.map(row => row.official_key));
    if (officialTextures.every(asset => present.has(asset.key))) return;
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < officialTextures.length) {
      const asset = officialTextures[cursor++]!;
      const bytes = Uint8Array.from(atob(asset.png), character => character.charCodeAt(0));
      await env.BUCKET.put(textureObjectKey(asset.hash), bytes, { httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' } });
    }
  }));
  const statements = [];
  for (let start = 0; start < officialTextures.length; start += 10) {
    const batch = officialTextures.slice(start, start + 10);
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO textures (official_key,catalog_revision,hash,kind,model,name,size_bytes,width,height,visibility,likes,created_at,updated_at,uploader_id,origin) VALUES ' + batch.map(() => "(?,?,?,?,?,?,?,?,?,'public',0,0,0,NULL,'repost')").join(','))
      .bind(...batch.flatMap(asset => [asset.key, revision, asset.hash, asset.kind, asset.model, asset.name, asset.sizeBytes, asset.width, asset.height])));
  }
  // revision 只增不降：官方更新任务可能已把 revision 累计到高于本目录常量，
  // 降级会让 user_default_catalog 的回填条件永远不成立
  statements.push(env.DB.prepare(`INSERT INTO official_catalog_state (id,revision) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET revision = ${scalarMax('official_catalog_state.revision', 'excluded.revision')}`).bind(revision));
  await env.DB.batch(statements);
}

// ── 完成态缓存 ──────────────────────────────────────────────────────────────
// WeakMap 键是 env.DB。目录初始化只在 isolate 内验证一次；官方更新任务与后台
// 运维改动官方目录时不经过这里，缓存随 isolate 生命周期收敛（无 TTL，区别于
// settingsCache 的 60 秒窗口——目录常量在部署内不变，无需过期）。
// 用户回填缓存带 60 秒 TTL：official_catalog_state.revision 被官方更新任务推高
// 后，已达标用户的增量回填最多延迟一个窗口，与 settingsCache 失效节奏一致。
// 测试的 isolatedStorage 只重置存储、env.DB 对象复用，用例间需手动 reset。
const initialized = new WeakMap<Bindings['DB'], Promise<void>>();
const defaultClosetSettled = new WeakMap<Bindings['DB'], Map<number, number>>();
const DEFAULT_CLOSET_TTL_MS = 60_000;

/** 丢弃官方目录的初始化完成态与用户回填缓存（测试/运维专用）。 */
export function resetOfficialCatalogCache(db: Bindings['DB']): void {
  initialized.delete(db);
  defaultClosetSettled.delete(db);
}

export async function ensureOfficialCatalog(env: Pick<Bindings, 'DB' | 'BUCKET' | 'OFFICIAL_CATALOG_ENABLED'>) {
  if (env.OFFICIAL_CATALOG_ENABLED === 'false') return;
  let pending = initialized.get(env.DB);
  if (!pending) {
    pending = initialize(env).catch(error => {
      // 失败不缓存，下个请求重试；initialize 内部已保证幂等
      initialized.delete(env.DB);
      throw error;
    });
    initialized.set(env.DB, pending);
  }
  await pending;
}

export async function ensureDefaultCloset(env: Pick<Bindings, 'DB' | 'OFFICIAL_CATALOG_ENABLED'>, userId: number) {
  if (env.OFFICIAL_CATALOG_ENABLED === 'false') return;
  const settled = defaultClosetSettled.get(env.DB);
  const now = Date.now();
  if (settled?.get(userId)! > now) return;
  const current = await env.DB.prepare('SELECT revision FROM user_default_catalog WHERE user_id = ?').bind(userId).first<{ revision: number }>();
  const latest = await env.DB.prepare('SELECT revision FROM official_catalog_state WHERE id = 1').first<{ revision: number }>();
  const target = latest?.revision ?? revision;
  if (current && current.revision >= target) {
    (settled ?? defaultClosetSettled.set(env.DB, new Map()).get(env.DB)!).set(userId, now + DEFAULT_CLOSET_TTL_MS);
    return;
  }
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO user_default_catalog (user_id,revision) VALUES (?,0)').bind(userId),
    env.DB.prepare('UPDATE textures SET likes = likes + 1 WHERE official_key IS NOT NULL AND catalog_revision > (SELECT revision FROM user_default_catalog WHERE user_id = ?) AND NOT EXISTS (SELECT 1 FROM closet WHERE user_id = ? AND texture_id = textures.id)').bind(userId, userId),
    env.DB.prepare("INSERT OR IGNORE INTO closet (user_id,texture_id,item_name,created_at,is_default) SELECT ?,id,name,0,1 FROM textures WHERE official_key IS NOT NULL AND catalog_revision > (SELECT revision FROM user_default_catalog WHERE user_id = ?)").bind(userId, userId),
    env.DB.prepare('UPDATE user_default_catalog SET revision = ? WHERE user_id = ?').bind(target, userId),
  ]);
}
