// Minecraft 客户端协议 —— **外部契约，字节级兼容**。
//
// 这个文件里唯一不能自由改动的东西就是响应结构。它消费方是 CustomSkinLoader，
// 任何字段变动都会让所有玩家的皮肤不再渲染。精确形态与逐条理由见
// docs/rewrite/07-minecraft-api.md 与 packages/minecraft/src/csl.ts。
//
// 性能设计：纹理字节走 Cache API 的 cache-aside。缓存命中时不做 D1 查询、
// 不做 R2 读取，CPU 接近 0。
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  buildPlayerProfile, serializePlayerProfile, textureObjectKey,
  PLAYER_PROFILE_CACHE_CONTROL, TEXTURE_CACHE_CONTROL,
  PLAYER_BANNED_MESSAGE, TEXTURE_OBJECT_MISSING_STATUS,
  textureEtag, playerProfileEtag,
} from '@pigeon-skin/minecraft';
import { createDb, players, textures, users, noCaseEq } from '@pigeon-skin/db';
import { eq, sql, type SQL } from 'drizzle-orm';

/** 把 helper 产出的含 {COL} 列占位与单个 ? 值占位的 SQL 片段嵌入 drizzle 模板。 */
function embedFrag(frag: string, column: SQL, value: unknown) {
  const [lhs = '', rhs = ''] = frag.split('{COL}');
  const q = rhs.indexOf('?');
  return sql`${sql.raw(lhs)}${column}${sql.raw(rhs.slice(0, q))}${value}${sql.raw(rhs.slice(q + 1))}`;
}
import type { Role, TextureModel } from '@pigeon-skin/shared';
import { getSettingBool } from '../lib.ts';
import { getSettingInt } from '../lib.ts';
import { canViewTextureHash, texturePubliclyReachable } from '../services/texture-access.ts';
import type { AppEnv } from '../lib.ts';

type Ctx = Context<AppEnv>;

/**
 * 直接在传入的 app 上注册协议路由。
 *
 * 不用 `app.route('/', subApp)` 挂载子应用：在 Hono 4 里以 '/' 为基路径
 * 挂载不会匹配到任何请求（实测所有协议路由都返回 404），
 * 而这些路由必须位于根路径，不能挪到别的前缀下。
 */
export function registerProtocolRoutes(app: Hono<AppEnv>): void {

// ── 玩家档案 ─────────────────────────────────────────────────────────────────
// 根路径与 /csl 前缀是同一个处理器：两者都必须存在，客户端会自行选择。

async function playerProfileHandler(c: Ctx, name: string) {
  const db = createDb(c.env.DB);
  // 玩家名唯一性不区分大小写，查询也必须按 NOCASE
  const rows = await db
    .select({
      id: players.id,
      name: players.name,
      updatedAt: players.updatedAt,
      role: users.role,
      skinTextureId: players.skinTextureId,
      capeTextureId: players.capeTextureId,
    })
    .from(players)
    .innerJoin(users, eq(users.id, players.userId))
    .where(embedFrag(noCaseEq('{COL}', '?'), sql`${players.name}`, name))
    .limit(1);

  const row = rows[0];
  if (!row) return c.notFound();

  // 所有者被封禁 → 403。这是契约的一部分：CSL 会把它呈现为"该玩家被封禁"。
  if ((row.role as Role) === 'banned') {
    return c.json({ error: PLAYER_BANNED_MESSAGE }, 403);
  }

  // 皮肤与披风分开查：两次单行查询比一次带别名 hack 的 join 更好懂，
  // 而且命中的是主键索引，成本可以忽略。
  const [skin] = row.skinTextureId
    ? await db.select({ hash: textures.hash, model: textures.model, visibility: textures.visibility })
        .from(textures).where(eq(textures.id, row.skinTextureId)).limit(1)
    : [];
  const [cape] = row.capeTextureId
    ? await db.select({ hash: textures.hash, visibility: textures.visibility })
        .from(textures).where(eq(textures.id, row.capeTextureId)).limit(1)
    : [];

  const profile = buildPlayerProfile({
    playerName: row.name,
    skin: skin ? { hash: skin.hash, model: (skin.model ?? 'default') as TextureModel } : null,
    cape: cape ? { hash: cape.hash } : null,
  });

  const etag = playerProfileEtag(row.id, row.updatedAt);
  const lastModified = new Date(row.updatedAt).toUTCString();
  const profileCache = skin?.visibility === 'private' || cape?.visibility === 'private' ? 'private, no-store' : PLAYER_PROFILE_CACHE_CONTROL;

  // 条件请求：If-None-Match（CSL 原样回显 ETag）与 If-Modified-Since
  // （秒级精度，Last-Modified 比较）都返回 304，响应头保持完整以便客户端续用。
  const ifModifiedSince = c.req.header('if-modified-since');
  const notModified = c.req.header('if-none-match') === etag
    || (c.req.header('if-none-match') === undefined && ifModifiedSince !== undefined
      && !Number.isNaN(Date.parse(ifModifiedSince))
      && Math.floor(new Date(ifModifiedSince).getTime() / 1000) >= Math.floor(row.updatedAt / 1000));
  if (notModified) {
    return c.body(null, 304, { ETag: etag, 'Cache-Control': profileCache, 'Last-Modified': lastModified });
  }

  return c.body(serializePlayerProfile(profile), 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': profileCache,
    'ETag': etag,
    'Last-Modified': lastModified,
  });
}

/**
 * 协议里玩家档案在根路径 `/{player}.json`。
 *
 * 这里**没有**用 Hono 的正则参数语法（`:player{.+\.json}`）—— 实测在 Hono 4 里
 * 它匹配不到任何请求，所有协议路径都落进 404。改成匹配单个路径段、
 * 自己在处理器里判断 `.json` 后缀：非 `.json` 就 `next()` 交还给后续路由，
 * 因此不会遮蔽其它路径，语义也更好读。
 */
const JSON_SUFFIX = '.json';

app.get('/:file', async (c, next) => {
  const file = c.req.param('file');
  if (!file.endsWith(JSON_SUFFIX)) return next();
  return playerProfileHandler(c, file.slice(0, -JSON_SUFFIX.length));
});

app.get('/csl/:file', async (c, next) => {
  const file = c.req.param('file');
  if (!file.endsWith(JSON_SUFFIX)) return next();
  return playerProfileHandler(c, file.slice(0, -JSON_SUFFIX.length));
});

// ── 纹理字节 ─────────────────────────────────────────────────────────────────

async function textureHandler(c: Ctx) {
  const hash = c.req.param('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return c.notFound();
  const publicAccess = await texturePubliclyReachable(c.env, hash);
  if (!publicAccess && !await canViewTextureHash(c.env, hash, c.get('user'))) {
    const status = await getSettingInt(c.env, 'private_texture_status');
    return c.body(null, status === 404 ? 404 : 403, { 'Cache-Control': 'private, no-store' });
  }

  // 条件请求要在读缓存/R2 之前判：ETag 就是哈希本身，无状态可查，
  // 命中时连 Cache API 的 match 都省了。
  const etag = textureEtag(hash);
  if (publicAccess && c.req.header('if-none-match') === etag) {
    return c.body(null, 304, {
      'ETag': etag,
      'Cache-Control': TEXTURE_CACHE_CONTROL,
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(`/textures/${hash}`, c.req.url).toString(), { method: 'GET' });

  // cache-aside：命中时不做 D1 查询、不读 R2，CPU 接近 0。
  //
  // 注意这里**必须**把缓存响应包一层新的 Response 再返回：
  // Cache API 返回的响应头是不可变的，而出站中间件（secureHeaders）会写响应头，
  // 直接 return hit 会抛 `TypeError: Can't modify immutable headers` —— 结果是
  // 每一次缓存命中的纹理请求都 500，也就是热路径全挂。包一层只是新建响应对象，
  // 不会复制 body 字节，成本可以忽略。
  const hit = publicAccess ? await cache.match(cacheKey) : null;
  if (hit) {
    return new Response(hit.body, {
      status: hit.status,
      statusText: hit.statusText,
      headers: new Headers(hit.headers),
    });
  }

  const object = await c.env.BUCKET.get(textureObjectKey(hash));
  if (!object) {
    // 元数据行存在但对象缺失 → 503（可恢复的存储故障），而不是 404
    // （404 在客户端看来是"纹理已删除"）。
    const db = createDb(c.env.DB);
    const exists = await db
      .select({ id: textures.id })
      .from(textures)
      .where(eq(textures.hash, hash))
      .limit(1);
    if (exists.length > 0) {
      return c.body(null, TEXTURE_OBJECT_MISSING_STATUS, { 'Retry-After': '60' });
    }
    return c.notFound();
  }

  const response = new Response(object.body, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(object.size),
      'Cache-Control': publicAccess ? TEXTURE_CACHE_CONTROL : 'private, no-store',
      'ETag': textureEtag(hash),
      'X-Content-Type-Options': 'nosniff',
    },
  });

  // 写入边缘缓存。内容地址不可变，所以缓存一年是安全的。
  if (publicAccess) c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

app.get('/textures/:hash', textureHandler);
app.get('/csl/textures/:hash', textureHandler);

// ── 按 tid 下载（受设置控制）────────────────────────────────────────────────

app.get('/raw/:tid', async (c) => {
  if (!(await getSettingBool(c.env, 'allow_texture_download'))) {
    return c.body(null, 403);
  }
  if (!c.get('user') && !(await getSettingBool(c.env, 'allow_anonymous_download'))) {
    return c.body(null, 401);
  }
  const tid = Number(c.req.param('tid'));
  if (!Number.isInteger(tid) || tid <= 0) return c.notFound();

  const db = createDb(c.env.DB);
  const rows = await db
    .select({ hash: textures.hash, visibility: textures.visibility })
    .from(textures)
    .where(eq(textures.id, tid))
    .limit(1);
  const hash = rows[0]?.hash;
  if (!hash) return c.notFound();
  if (!await texturePubliclyReachable(c.env, hash)) {
    const status = await getSettingInt(c.env, 'private_texture_status');
    return c.body(null, status === 404 ? 404 : 403, { 'Cache-Control': 'private, no-store' });
  }

  // tid → hash 是内容寻址的不变映射（纹理内容不可变，重传生成新行），
  // 因此与 /textures/{hash} 一样可以 immutable 缓存（契约 07 §2.4：头与
  // /textures 相同；旧版 raw 也在一年 TTL 的 etag 中间件清单里）。
  const rawEtag = textureEtag(hash);
  if (c.req.header('if-none-match') === rawEtag) {
    return c.body(null, 304, {
      'ETag': rawEtag,
      'Cache-Control': TEXTURE_CACHE_CONTROL,
    });
  }

  const object = await c.env.BUCKET.get(textureObjectKey(hash));
  if (!object) return c.body(null, TEXTURE_OBJECT_MISSING_STATUS, { 'Retry-After': '60' });

  return c.body(object.body, 200, {
    'Content-Type': 'image/png',
    'Content-Length': String(object.size),
    'Cache-Control': TEXTURE_CACHE_CONTROL,
    'ETag': rawEtag,
    'X-Content-Type-Options': 'nosniff',
  });
});
}
