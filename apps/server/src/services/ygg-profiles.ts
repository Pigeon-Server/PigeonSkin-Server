import { getSetting } from './../core/settings-reader.ts';
import { type AppEnv } from './../core/user.ts';
import { hashToken } from '@pigeon-skin/auth';
import { noCaseEq } from '@pigeon-skin/db';

import type { Context } from 'hono';

export interface GameProfile { id: string; name: string; playerId: number; version: number }
export function publicProfile(p: GameProfile) { return { id: p.id, name: p.name }; }

/** 读取角色当前已分配的 UUID 行；没有则分配并落库。
 *
 *  uuid 表按角色 PID 关联，但启动器记住的是 profileID —— 同名角色的 UUID
 *  必须跨删除保持稳定，否则启动器会判定「此角色已被删除」。归档表
 *  (uuid_archive) 保存已删除角色的「名字 → UUID」，同名重建时复用并消费。
 *  语义基准是上游 yggdrasil-api 插件（uuid 表按名字常驻、不随角色删除）。 */
export async function uuidForPlayer(c: Context<AppEnv>, playerId: number): Promise<GameProfile> {
  const existing = await c.env.DB.prepare('SELECT uuid AS id, name, player_id AS playerId, version FROM uuid WHERE player_id = ?').bind(playerId).first<GameProfile>();
  if (existing) return existing;
  const player = await c.env.DB.prepare('SELECT name FROM players WHERE id = ?').bind(playerId).first<{ name: string }>();
  if (!player) throw new Error('Player not found');

  const archived = await c.env.DB.prepare(`SELECT uuid FROM uuid_archive WHERE ${noCaseEq('name', '?')} LIMIT 1`).bind(player.name).first<{ uuid: string }>();
  let uuid = archived?.uuid ?? crypto.randomUUID().replace(/-/g, '');
  if (!archived && await getSetting(c.env, 'ygg_uuid_algorithm') === 'v3') {
    const bytes = new Uint8Array(await crypto.subtle.digest('MD5', new TextEncoder().encode(`OfflinePlayer:${player.name}`)));
    bytes[6] = (bytes[6]! & 15) | 48;
    bytes[8] = (bytes[8]! & 63) | 128;
    uuid = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  await insertUuidMapping(c.env.DB, { playerId, name: player.name, uuid });
  // 复用即消费：归档只保留「当前无活角色」的名字映射，避免死映射抢占在用 UUID
  if (archived) await c.env.DB.prepare('DELETE FROM uuid_archive WHERE uuid = ?').bind(archived.uuid).run();
  return (await c.env.DB.prepare('SELECT uuid AS id, name, player_id AS playerId, version FROM uuid WHERE player_id = ?').bind(playerId).first<GameProfile>())!;
}

/** 写入角色 UUID 映射。并发首次分配时同名/同 UUID 的唯一索引会先命中，
 *  用 INSERT OR IGNORE 让任一约束冲突都变成无操作（适配层会转成各方言的
 *  忽略语法），冲突即说明别的请求已写入，读回既有行即可。v3 下改名后同名
 *  重建会算出已被占用的 UUID，此时退回随机值，不能让唯一索引把登录打成 500。 */
async function insertUuidMapping(db: D1Database, input: { playerId: number; name: string; uuid: string }): Promise<void> {
  const insert = (uuid: string) => db.prepare('INSERT OR IGNORE INTO uuid (player_id, name, uuid) SELECT id, name, ? FROM players WHERE id = ?')
    .bind(uuid, input.playerId).run();
  await insert(input.uuid);
  if (await db.prepare('SELECT 1 FROM uuid WHERE player_id = ?').bind(input.playerId).first()) return;
  await insert(crypto.randomUUID().replace(/-/g, ''));
}

/** 删除角色/用户后把 (name, uuid) 归档。必须在删除成功后调用（uuid 行已随
 *  外键级联消失），失败的删除不得归档以免死映射指向活角色。
 *  同名旧归档先清掉：最近一次删除看到的 UUID 才是启动器记住的那个。 */
export async function insertUuidArchive(db: D1Database, entries: Array<{ name: string; uuid: string }>): Promise<void> {
  for (const entry of entries) {
    // 同名旧归档先清掉：最近一次删除看到的 UUID 才是启动器记住的那个；
    // INSERT OR IGNORE 兜住并发下另一请求已写入同 uuid 的窗口
    await db.prepare(`DELETE FROM uuid_archive WHERE ${noCaseEq('name', '?')}`).bind(entry.name).run();
    await db.prepare('INSERT OR IGNORE INTO uuid_archive (name, uuid) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM uuid_archive WHERE uuid = ?)')
      .bind(entry.name, entry.uuid, entry.uuid).run();
  }
}

/** 丢弃某名字的归档（角色已绑定官方 UUID 或改名占用了该名字时）。 */
export async function discardUuidArchive(db: D1Database, name: string): Promise<void> {
  await db.prepare(`DELETE FROM uuid_archive WHERE ${noCaseEq('name', '?')}`).bind(name).run();
}

/** 绑定官方 UUID（Mojang 验证/同步）。官方 UUID 优先于本地分配，且同名旧归档
 *  随之失效——否则删掉该角色后重建会拿回启动器记忆的旧 profileID。
 *  冲突忽略必须走 `INSERT OR IGNORE`：MySQL 适配层会把 drizzle 生成的
 *  `ON CONFLICT DO NOTHING` 整段剥除，退化成普通 INSERT 后唯一约束直接报错。 */
export async function bindOfficialUuid(db: D1Database, input: { playerId: number; name: string; uuid: string }): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO uuid (player_id, name, uuid) VALUES (?, ?, ?)')
    .bind(input.playerId, input.name, input.uuid).run();
  await discardUuidArchive(db, input.name);
}

/** 读取角色当前的 (name, uuid)，供删除路径在删除前取用。 */
export async function playerUuidEntry(db: D1Database, playerId: number): Promise<{ name: string; uuid: string } | null> {
  return db.prepare('SELECT p.name AS name, u.uuid AS uuid FROM players p JOIN uuid u ON u.player_id = p.id WHERE p.id = ?')
    .bind(playerId).first<{ name: string; uuid: string }>();
}

/** 读取用户名下全部角色的 (name, uuid)，供删用户路径在删除前取用。 */
export async function userUuidEntries(db: D1Database, userId: number): Promise<Array<{ name: string; uuid: string }>> {
  const { results } = await db.prepare('SELECT p.name AS name, u.uuid AS uuid FROM players p JOIN uuid u ON u.player_id = p.id WHERE p.user_id = ?')
    .bind(userId).all<{ name: string; uuid: string }>();
  return results;
}
export async function gameProfiles(c: Context<AppEnv>, userId: number) {
  const { results } = await c.env.DB.prepare('SELECT id FROM players WHERE user_id = ? ORDER BY id').bind(userId).all<{ id: number }>();
  return Promise.all(results.map(p => uuidForPlayer(c, p.id)));
}
export async function userUuid(userId: number) { return (await hashToken(`blessing:user:${userId}`)).slice(0, 32); }
