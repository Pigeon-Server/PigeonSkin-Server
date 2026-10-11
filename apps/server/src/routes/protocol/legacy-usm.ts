// legacy-api 与 usm-api 内置 —— 两个旧协议插件的原样移植。
//
// legacy-api：/skin/{player}.png 与 /cape/{player}.png。
//   语义照搬原插件：角色不存在 / 材质记录缺失 / 文件缺失均 404，**无默认皮肤回退**；
//   所属用户被封禁 403。
//
// usm-api：/usm/{player}.json 与 /usm/textures/{hash}。
//   响应结构逐字段照搬原 ProfileController：
//   { player_name, last_update, model_preference, skins: {default|slim: hash|null}, cape }
//   皮肤类型 default（steve）→ model_preference ["default"]；slim → ["slim"]；
//   无皮肤也报 ["default"]。角色不存在 404 {"errno":1,"msg":"Player not found."}，封禁 403。
//
// 这些路径在根路径（客户端/模组写死），由 app.ts 挂载。

import { type AppEnv } from '../../core/user.ts';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb, players, textures, users, noCaseEq } from '@pigeon-skin/db';
import { eq, sql, type SQL } from 'drizzle-orm';

/** 把 helper 产出的含 {COL} 列占位与单个 ? 值占位的 SQL 片段嵌入 drizzle 模板。 */
function embedFrag(frag: string, column: SQL, value: unknown) {
  const [lhs = '', rhs = ''] = frag.split('{COL}');
  const q = rhs.indexOf('?');
  return sql`${sql.raw(lhs)}${column}${sql.raw(rhs.slice(0, q))}${value}${sql.raw(rhs.slice(q + 1))}`;
}
import { REVALIDATE_CACHE_CONTROL, TEXTURE_CACHE_CONTROL, TEXTURE_OBJECT_MISSING_STATUS, textureObjectKey, textureEtag } from '@pigeon-skin/minecraft';

import { texturePubliclyReachable } from '../../services/texture-access.ts';

type Ctx = Context<AppEnv>;

export interface LoadedPlayer {
  pid: number;
  name: string;
  updatedAt: number;
  skinTid: number | null;
  capeTid: number | null;
}

/** 按角色名取玩家与拥有者角色。status='missing' 时为 null；'banned' 仅有状态。 */
async function loadPlayer(c: Ctx, name: string): Promise<LoadedPlayer | 'banned' | null> {
  const [row] = await createDb(c.env.DB)
    .select({
      pid: players.id,
      name: players.name,
      updatedAt: players.updatedAt,
      role: users.role,
      skinTid: players.skinTextureId,
      capeTid: players.capeTextureId,
    })
    .from(players)
    .innerJoin(users, eq(users.id, players.userId))
    .where(embedFrag(noCaseEq('{COL}', '?'), sql`${players.name}`, name))
    .limit(1);
  if (!row) return null;
  if (row.role === 'banned') return 'banned';
  return {
    pid: row.pid, name: row.name, updatedAt: row.updatedAt,
    skinTid: row.skinTid, capeTid: row.capeTid,
  };
}

async function textureHashOf(c: Ctx, tid: number | null): Promise<string | null> {
  if (!tid) return null;
  const [t] = await createDb(c.env.DB)
    .select({ hash: textures.hash })
    .from(textures)
    .where(eq(textures.id, tid))
    .limit(1);
  return t?.hash ?? null;
}

/** 直出纹理字节（私有不可达 404 —— 照搬原插件；对象缺失与 /textures 同语义：
 *  503 + Retry-After（可恢复存储故障））。
 *
 *  缓存指令由调用方给：`/usm/textures/{hash}` 是按哈希寻址、可以 immutable；
 *  `/skin|/cape/{player}.png` 的 URL 是**角色名**寻址，换肤后 URL 不变，
 *  只能短新鲜窗口 + 重验证（旧站靠 refresh-qcloud-cdn 插件刷这两个 URL，
 *  重写版不再依赖 CDN 刷新 —— 至少不能对可变 URL 承诺一年 immutable）。
 *  ETag 两种情况都用内容哈希，内容一换就变。 */
async function serveTexture(c: Ctx, hash: string, cacheControl: string): Promise<Response> {
  if (!await texturePubliclyReachable(c.env, hash)) return c.notFound();
  if (c.req.header('if-none-match') === textureEtag(hash)) {
    return c.body(null, 304, { ETag: textureEtag(hash), 'Cache-Control': cacheControl });
  }
  const object = await c.env.BUCKET.get(textureObjectKey(hash));
  if (!object) return c.body(null, TEXTURE_OBJECT_MISSING_STATUS, { 'Retry-After': '60' });
  return c.body(object.body, 200, {
    'Content-Type': 'image/png',
    'Content-Length': String(object.size),
    'Cache-Control': cacheControl,
    'ETag': textureEtag(hash),
    'X-Content-Type-Options': 'nosniff',
  });
}

export function registerLegacyProtocolRoutes(app: Hono<AppEnv>): void {
  // ── legacy-api ─────────────────────────────────────────────────────────────
  const legacy = async (c: Ctx, kind: 'skin' | 'cape') => {
    const name = (c.req.param('player') ?? '').replace(/\.png$/, '');
    const row = await loadPlayer(c, name);
    if (row === null) return c.notFound();
    if (typeof row === 'string') return c.json({ error: 'This player is banned.' }, 403);
    const hash = await textureHashOf(c, kind === 'skin' ? row.skinTid : row.capeTid);
    if (!hash) return c.notFound();
    return serveTexture(c, hash, REVALIDATE_CACHE_CONTROL);
  };
  app.get('/skin/:player', (c) => legacy(c, 'skin'));
  app.get('/cape/:player', (c) => legacy(c, 'cape'));

  // ── usm-api ────────────────────────────────────────────────────────────────
  app.get('/usm/:player', async (c) => {
    const name = (c.req.param('player') ?? '').replace(/\.json$/, '');
    const row = await loadPlayer(c, name);
    if (row === null) return c.json({ errno: 1, msg: 'Player not found.' }, 404);
    if (typeof row === 'string') return c.json({ errno: 2, msg: 'This player is banned.' }, 403);

    const skinRows = row.skinTid
      ? await createDb(c.env.DB)
          .select({ hash: textures.hash, model: textures.model })
          .from(textures).where(eq(textures.id, row.skinTid)).limit(1)
      : [];
    const skin: { hash: string; model: string | null } | undefined = skinRows[0];
    const capeHash = await textureHashOf(c, row.capeTid);

    const model = skin?.model === 'slim' ? 'slim' : 'default';
    // 缓存语义与 protocol.ts 的玩家档案一致：含私有哈希披露的档案不进共享缓存。
    // usm 契约与 Player::toJson 同构：skins 恰好一个键（由 model 决定）、
    // player_name 回显存储原名（大小写不敏感匹配命中的是另一个写法）。
    return c.body(JSON.stringify({
      player_name: row.name,
      last_update: Math.floor(row.updatedAt / 1000),
      model_preference: [model],
      skins: { [model]: skin?.hash ?? null },
      cape: capeHash,
    }), 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  });

  app.get('/usm/textures/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!/^[0-9a-f]{64}$/.test(hash)) return c.notFound();
    // 这条是按哈希寻址的，URL 就是内容地址 —— immutable 成立
    return serveTexture(c, hash, TEXTURE_CACHE_CONTROL);
  });
}
