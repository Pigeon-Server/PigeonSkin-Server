import type { AuthedUser } from '../lib.ts';
import { isAdmin } from '../lib.ts';
import type { Bindings } from '../env.ts';

type TextureAccessEnv = Pick<Bindings, 'DB'> & { BUCKET?: Bindings['BUCKET']; APP_URL?: string };

export async function texturePubliclyReachable(env: Pick<Bindings, 'DB'>, hash: string): Promise<boolean> {
  const result = await env.DB.prepare(`SELECT 1 AS visible FROM textures t
    WHERE t.hash=? AND (t.visibility='public' OR EXISTS (
      SELECT 1 FROM players p JOIN users u ON u.id=p.user_id
      WHERE u.role!='banned' AND (p.skin_texture_id=t.id OR p.cape_texture_id=t.id)
    )) LIMIT 1`).bind(hash).first<{ visible: number }>();
  return !!result;
}

export async function canViewTextureHash(env: Pick<Bindings, 'DB'>, hash: string, viewer: AuthedUser | null): Promise<boolean> {
  if (await texturePubliclyReachable(env, hash)) return true;
  if (!viewer || viewer.role === 'banned') return false;
  if (isAdmin(viewer)) return true;
  return !!await env.DB.prepare("SELECT 1 FROM textures WHERE hash=? AND visibility='private' AND uploader_id=? LIMIT 1").bind(hash, viewer.id).first();
}

export async function canViewTextureId(env: Pick<Bindings, 'DB'>, id: number, viewer: AuthedUser | null): Promise<{ hash: string; visible: boolean } | null> {
  const texture = await env.DB.prepare('SELECT hash FROM textures WHERE id=?').bind(id).first<{ hash: string }>();
  if (!texture) return null;
  return { hash: texture.hash, visible: await canViewTextureHash(env, texture.hash, viewer) };
}

export async function purgeTextureDerivatives(env: TextureAccessEnv, hash: string): Promise<void> {
  const base = (env.APP_URL || 'https://texture-cache.invalid').replace(/\/$/, '');
  for (const path of [`/textures/${hash}`, `/csl/textures/${hash}`]) {
    await caches.default.delete(new Request(`${base}${path}`)).catch(() => false);
  }
  if (!env.BUCKET) return;
  await env.BUCKET.delete(`previews/v3/${hash}.png`);
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: `avatars/v3/${hash}/`, ...(cursor ? { cursor } : {}), limit: 1000 });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function purgePlayerProfiles(env: TextureAccessEnv, name: string): Promise<void> {
  const base = (env.APP_URL || 'https://texture-cache.invalid').replace(/\/$/, '');
  for (const path of [`/${encodeURIComponent(name)}.json`, `/csl/${encodeURIComponent(name)}.json`, `/usm/${encodeURIComponent(name)}`, `/usm/${encodeURIComponent(name)}.json`]) {
    await caches.default.delete(new Request(`${base}${path}`)).catch(() => false);
  }
}

/**
 * 清 `/avatar/user/:id` 的 Cache API 键。
 *
 * 当前 userAvatar 直接读 R2/按需生成、从不写 caches.default，因此这是
 * 防御性调用：一旦头像读取路径引入边缘缓存，调用点无需改动。保留成本低。
 */
export async function purgeUserAvatar(env: TextureAccessEnv, userId: number): Promise<void> {
  const base = (env.APP_URL || 'https://texture-cache.invalid').replace(/\/$/, '');
  for (const mode of ['2d', '3d']) for (const size of [64, 100]) {
    await caches.default.delete(new Request(`${base}/avatar/user/${userId}?mode=${mode}&size=${size}`)).catch(() => false);
  }
}

export async function purgeUnsharedPrivateHashes(env: TextureAccessEnv, ids: Array<number | null | undefined>): Promise<void> {
  const unique = [...new Set(ids.filter((id): id is number => typeof id === 'number' && id > 0))];
  for (const id of unique) {
    const texture = await env.DB.prepare("SELECT hash FROM textures WHERE id=? AND visibility='private'").bind(id).first<{ hash: string }>();
    if (texture && !await texturePubliclyReachable(env, texture.hash)) await purgeTextureDerivatives(env, texture.hash);
  }
}
