import { Hono } from 'hono';
import type { Context } from 'hono';
import { defaultAvatarModel, defaultAvatarUrls } from '@pigeon-skin/shared/default-skins';
import { hashToken } from '@pigeon-skin/auth';
import {
  avatarObjectKey, previewObjectKey, isAllowedDerivativeSize,
  DERIVATIVE_CACHE_CONTROL, decodePng, encodePng,
} from '@pigeon-skin/minecraft';
import { flag } from '../env.ts';
import { isAdmin, type AppEnv } from '../lib.ts';
import { canViewTextureHash, texturePubliclyReachable } from '../services/texture-access.ts';

type Ctx = Context<AppEnv>;

const DERIVATIVE_MISSING_CACHE_CONTROL = 'public, max-age=60';

/** 头像哈希校验：64 位十六进制小写，与纹理哈希同源 */
function isHash(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/**
 * 未命中时的按需生成。返回产物 Response，或 null（开关关闭/生成失败）。
 *
 * 交给 DO 而不是在本 Worker 里生成：DO 的 input gates 把同名请求串行化，
 * 避免 N 个 isolate 对同一个缺失衍生图各生成一遍、竞争写 R2。
 */
async function generateOnMiss(c: Ctx, hash: string, kind: string, publicAccess: boolean): Promise<Response | null> {
  if (!flag(c.env.DERIVATIVES_ENABLED)) return null;
  const id = c.env.DERIVATIVES.idFromName(hash);
  const stub = c.env.DERIVATIVES.get(id);
  const generated = await stub.fetch(`https://do/generate?hash=${hash}&kind=${encodeURIComponent(kind)}`);
  if (!generated.ok) return null;
  const headers: Record<string, string> = {
    'Content-Type': 'image/png',
    'Cache-Control': publicAccess ? DERIVATIVE_CACHE_CONTROL : 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // DO 响应带精确长度；保留它让客户端能提前分配缓冲
  const length = generated.headers.get('content-length');
  if (length) headers['Content-Length'] = length;
  return new Response(generated.body, { headers });
}

async function serveAvatar(c: Ctx, hash: string, kind: string, publicAccess: boolean): Promise<Response> {
  const mode = kind.startsWith('avatar-3d') ? '3d' : '2d';
  const size = Number(kind.split('-')[2]);
  const key = avatarObjectKey(hash, mode as '2d' | '3d', size);
  const etag = `"av-${hash}-${mode}-${size}-3"`;

  const cacheControl = publicAccess ? DERIVATIVE_CACHE_CONTROL : 'private, no-store';
  if (publicAccess && c.req.header('if-none-match') === etag) {
    return c.body(null, 304, { ETag: etag, 'Cache-Control': cacheControl });
  }

  const object = await c.env.BUCKET.get(key);
  if (object) {
    return c.body(object.body, 200, {
      'Content-Type': 'image/png',
      'Content-Length': String(object.size),
      'Cache-Control': cacheControl,
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff',
    });
  }

  let generated: Response | null;
  try { generated = await generateOnMiss(c, hash, kind, publicAccess); } catch { generated = null; }
  if (generated) {
    generated.headers.set('ETag', etag);
    return generated;
  }
  // R2 is the only read path after a DO miss. This keeps all generation and
  // persistence behind the DERIVATIVES_ENABLED gate in the generator.
  return c.body(null, 404, { 'Cache-Control': publicAccess ? DERIVATIVE_MISSING_CACHE_CONTROL : 'private, no-store' });
}
async function userAvatar(c: Ctx, userId: number) {
  const size = Number(c.req.query('size') || 100);
  if (!Number.isInteger(size) || !isAllowedDerivativeSize(size)) return c.notFound();
  const mode = c.req.query('mode') === '3d' || c.req.query('3d') !== undefined ? '3d' : '2d';
  const texture = await c.env.DB.prepare("SELECT t.hash,t.visibility,t.uploader_id as uploaderId FROM users u JOIN textures t ON t.id = u.avatar_texture_id AND t.kind = 'skin' WHERE u.id = ?").bind(userId).first<{ hash: string; visibility: string; uploaderId: number | null }>();
  const viewer = c.get('user');
  const texturePublic = !!texture && (texture.visibility === 'public' || await texturePubliclyReachable(c.env, texture.hash));
  const privateOwner = !!texture && texture.visibility === 'private' && !!viewer && (viewer.id === texture.uploaderId || viewer.id === userId || isAdmin(viewer));
  const selected = texture && (texturePublic || privateOwner) ? texture : null;
  const publicAccess = !selected || texturePublic;
  const identity = `${userId}:${selected?.hash || 'default'}:${mode}:${size}:3`;
  const etag = `"avatar-${await hashToken(identity)}"`;
  const headers = { 'Cache-Control': publicAccess ? 'public, max-age=60' : 'private, no-store', ETag: etag };
  if (publicAccess && c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
  if (selected) {
    const image = await serveAvatar(c, selected.hash, `avatar-${mode}-${size}`, publicAccess);
    if (image.ok) {
      return new Response(image.body, { status: 200, headers: { ...headers, 'Content-Type': 'image/png' } });
    }
  }
  const uri = defaultAvatarUrls[defaultAvatarModel(userId)][mode];
  const bytes = Uint8Array.from(atob(uri.split(',')[1]!), ch => ch.charCodeAt(0));
  const decoded = await decodePng(bytes);
  if (!decoded.ok) return c.notFound();
  const { width, height, rgba } = decoded.image;
  if (width === size && height === size) return c.body(bytes, 200, { ...headers, 'Content-Type': 'image/png' });
  const resized = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const source = (Math.floor(y * height / size) * width + Math.floor(x * width / size)) * 4;
    resized.set(rgba.subarray(source, source + 4), (y * size + x) * 4);
  }
  const png = await encodePng(size, size, resized);
  return c.body(new Uint8Array(png), 200, { ...headers, 'Content-Type': 'image/png' });
}

async function servePreview(c: Ctx, hash: string, publicAccess: boolean): Promise<Response> {
  const key = previewObjectKey(hash);
  const etag = `"pv-${hash}-3"`;

  const cacheControl = publicAccess ? DERIVATIVE_CACHE_CONTROL : 'private, no-store';
  if (publicAccess && c.req.header('if-none-match') === etag) {
    return c.body(null, 304, { ETag: etag, 'Cache-Control': cacheControl });
  }

  const object = await c.env.BUCKET.get(key);
  if (object) {
    return c.body(object.body, 200, {
      'Content-Type': 'image/png',
      'Content-Length': String(object.size),
      'Cache-Control': cacheControl,
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff',
    });
  }

  const generated = await generateOnMiss(c, hash, 'preview', publicAccess);
  if (generated) {
    generated.headers.set('ETag', etag);
    return generated;
  }
  return c.body(null, 404, { 'Cache-Control': publicAccess ? DERIVATIVE_MISSING_CACHE_CONTROL : 'private, no-store' });
}

export function registerDerivativeRoutes(app: Hono<AppEnv>): void {
  app.get('/avatar/user/:id', c => {
    const id = Number(c.req.param('id'));
    return Number.isSafeInteger(id) && id >= 0 ? userAvatar(c, id) : c.notFound();
  });
  // GET /avatar/{hash}?mode=2d|3d&size=N
  app.get('/avatar/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!isHash(hash)) return c.notFound();

    const mode = c.req.query('mode') === '3d' || c.req.query('3d') !== undefined ? '3d' : '2d';
    const size = Number(c.req.query('size') ?? 100);
    if (!Number.isInteger(size) || !isAllowedDerivativeSize(size)) return c.notFound();
    const publicAccess = await texturePubliclyReachable(c.env, hash);
    if (!publicAccess && !await canViewTextureHash(c.env, hash, c.get('user'))) {
      return c.body(null, 404, { 'Cache-Control': 'private, no-store' });
    }
    const metadata = await c.env.DB.prepare('SELECT kind FROM textures WHERE hash = ? ORDER BY (kind = ?) DESC LIMIT 1').bind(hash, 'skin').first<{ kind: string }>();
    if (metadata?.kind === 'cape') return c.body(null, 422, { 'Cache-Control': DERIVATIVE_MISSING_CACHE_CONTROL });

    return serveAvatar(c, hash, `avatar-${mode}-${size}`, publicAccess);
  });

  // GET /preview/{hash}
  app.get('/preview/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!isHash(hash)) return c.notFound();

    const publicAccess = await texturePubliclyReachable(c.env, hash);
    if (!publicAccess && !await canViewTextureHash(c.env, hash, c.get('user'))) return c.body(null, 404, { 'Cache-Control': 'private, no-store' });
    return servePreview(c, hash, publicAccess);
  });
}
