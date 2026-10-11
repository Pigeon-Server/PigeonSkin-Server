import { avatarObjectPrefix, previewObjectKey, type PreviewRenderIdentity } from '@pigeon-skin/minecraft';
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
  await env.BUCKET.delete(previewObjectKey(hash));
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: avatarObjectPrefix(hash), ...(cursor ? { cursor } : {}), limit: 1000 });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// ── 预览渲染身份 ─────────────────────────────────────────────────────────────
// 签名本身（拼/解）在 @pigeon-skin/minecraft：前端拼 URL、服务端判定缓存指令
// 用的是同一份规则。这里只负责"库内当前是哪一个身份"。

/**
 * 库内该哈希当前的渲染身份。优先级与 DO 生成衍生图时一致（两处都走这里）：
 * 同一哈希同时存在 skin 与 cape 两行时（64×32 两种都合法）取 skin。
 */
export async function textureRenderIdentity(
  env: Pick<Bindings, 'DB'>, hash: string,
): Promise<PreviewRenderIdentity> {
  const row = await env.DB.prepare(
    "SELECT kind, model FROM textures WHERE hash=? ORDER BY (kind = 'skin') DESC LIMIT 1",
  ).bind(hash).first<{ kind: string; model: string | null }>();
  if (row?.kind === 'cape') return { kind: 'cape', model: 'default' };
  return { kind: 'skin', model: row?.model === 'slim' ? 'slim' : 'default' };
}

/**
 * 清一个角色名下所有协议出口的边缘缓存。
 *
 * 清单与旧站 refresh-qcloud-cdn 插件一致：资料 JSON 四个写法 + legacy-api 的
 * `/skin|/cape/{name}.png`（换肤后这两个 URL 不变，插件当年就是靠刷新它们让
 * 客户端看到新皮肤的）。
 */
export async function purgePlayerProfiles(env: TextureAccessEnv, name: string): Promise<void> {
  const base = (env.APP_URL || 'https://texture-cache.invalid').replace(/\/$/, '');
  const encoded = encodeURIComponent(name);
  const paths = [
    `/${encoded}.json`, `/csl/${encoded}.json`, `/usm/${encoded}`, `/usm/${encoded}.json`,
    `/skin/${encoded}.png`, `/cape/${encoded}.png`,
  ];
  for (const path of paths) {
    await caches.default.delete(new Request(`${base}${path}`)).catch(() => false);
  }
}

/**
 * 谁穿戴着这张纹理（`skin_texture_id` 或 `cape_texture_id` 命中），返回角色名。
 *
 * 给了 `touchAt` 就顺手把这些角色行的 `updated_at` 推进：`/{name}.json` 的 ETag
 * 与 Last-Modified 都取自它，而材质内容被覆盖/材质被删除时角色资料的内容变了、
 * 角色行指纹却不会自己变 —— 不推进，客户端带旧 ETag 重验证会拿到 304，继续用
 * 随后就被删掉的旧哈希（游戏里就是皮肤加载失败）。见 06 §6.5。
 *
 * 无论哪种用法，都必须在删除/改写**之前**调用：指针被外键置空后就查不到了。
 */
export async function playersWearingTexture(
  env: Pick<Bindings, 'DB'>, textureId: number, touchAt?: number,
): Promise<string[]> {
  const statement = touchAt === undefined
    ? env.DB.prepare('SELECT name FROM players WHERE skin_texture_id=? OR cape_texture_id=?').bind(textureId, textureId)
    : env.DB.prepare('UPDATE players SET updated_at=? WHERE skin_texture_id=? OR cape_texture_id=? RETURNING name').bind(touchAt, textureId, textureId);
  const { results } = await statement.all<{ name: string }>();
  return (results ?? []).map(row => row.name);
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
