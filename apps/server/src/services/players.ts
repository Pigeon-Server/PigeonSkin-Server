// 玩家业务规则。
//
// 与旧版一致的语义：
//   • 创建扣 score_per_player，删除时按 refund_on_delete 退还
//   • 玩家名全局唯一且不区分大小写（旧版只在应用层保证，新 schema 是真约束）
//   • 没有每用户玩家数量上限 —— 只有积分挡着（旧版就是这样）
//   • tid 为 0/null 都表示"无皮肤/无披风"
import { createDb } from '@pigeon-skin/db';
import { isValidPlayerName, type PlayerNameRule } from '@pigeon-skin/shared';
import { fail, type Pagination } from '../framework.ts';
import { isAdmin } from '../lib.ts';
import * as repo from '../repositories/players.ts';
import { bumpSitemap } from './sitemap-cache.ts';
import type { Bindings } from '../env.ts';

export interface PlayerEnv {
  DB: Bindings['DB'];
  BUCKET?: Bindings['BUCKET'];
  APP_URL?: string;
}

function db(env: PlayerEnv) {
  return createDb(env.DB);
}

export interface NameRules {
  rule: PlayerNameRule;
  min: number;
  max: number;
  regexp?: string | undefined;
}

function assertValidName(name: string, rules: NameRules): void {
  if (!isValidPlayerName(name, rules.rule, rules.regexp)) {
    throw fail.invalid('player.name_invalid', { name: 'invalid' });
  }
  if (name.length < rules.min || name.length > rules.max) {
    throw fail.invalid('player.name_invalid', { name: 'invalid' });
  }
}

// ── 读取 ─────────────────────────────────────────────────────────────────────

export async function listOwnPlayers(env: PlayerEnv, userId: number) {
  return { items: await repo.listPlayersByUser(db(env), userId) };
}

export async function listPlayersForAdmin(
  env: PlayerEnv,
  filter: { keyword?: string | undefined },
  page: Pagination,
) {
  return repo.listPlayersPaged(db(env), filter, page);
}

/**
 * 取玩家并断言归属。
 *
 * 别人的玩家一律按"不存在"处理：403 与 404 的差异本身会成为
 * "这个 id 是否存在"的探针。管理员可以操作任何人的玩家。
 */
export async function getOwnedPlayer(
  env: PlayerEnv,
  actor: { id: number; role: string },
  id: number,
) {
  if (!Number.isInteger(id) || id <= 0) throw fail.notFound('player.not_found');
  const player = await repo.findPlayerById(db(env), id);
  if (!player) throw fail.notFound('player.not_found');
  if (player.userId !== actor.id && !isAdmin(actor as never)) {
    throw fail.notFound('player.not_found');
  }
  return player;
}

// ── 创建 ─────────────────────────────────────────────────────────────────────

export async function createPlayer(
  env: PlayerEnv,
  actor: { id: number },
  name: string,
  rules: NameRules,
  cost: number,
  freeCount = 0,
  maxCount = -1,
): Promise<{ id: number; scoreSpent: number }> {
  assertValidName(name, rules);

  const database = db(env);
  const owned = await env.DB.prepare('SELECT COUNT(*) AS count FROM players WHERE user_id = ?').bind(actor.id).first<{ count: number }>();
  const playerCount = Number(owned?.count || 0);
  if (maxCount >= 0 && playerCount >= maxCount) throw fail.forbidden('player.limit_reached');
  // 唯一性由 UNIQUE(name COLLATE NOCASE) 保证；先查一次只为给出干净的错误码
  if (await repo.findPlayerByNameInsensitive(database, name)) {
    throw fail.conflict('player.name_taken');
  }

  const charge = Math.max(0, cost);
  const now = Date.now();
  const freeExpression = '((SELECT COUNT(*) FROM players WHERE user_id=?) < ?)';
  const rawCount = '(SELECT COUNT(*) FROM players WHERE user_id=?)';
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET score=score-CASE WHEN ${freeExpression} THEN 0 ELSE ? END,updated_at=? WHERE id=? AND (${freeExpression} OR score>=?) AND (?<0 OR ${rawCount}<?)`)
      .bind(actor.id, freeCount, charge, now, actor.id, actor.id, freeCount, charge, maxCount, actor.id, maxCount),
    env.DB.prepare(`INSERT INTO players(user_id,name,score_paid,created_at,updated_at)
      SELECT ?,?,CASE WHEN (SELECT COUNT(*) FROM players WHERE user_id=?)<? THEN 0 ELSE ? END,?,? WHERE changes()>0 RETURNING id`)
      .bind(actor.id, name, actor.id, freeCount, charge, now, now),
  ]);
  if (!result[0]?.meta.changes) {
    const currentCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM players WHERE user_id=?').bind(actor.id).first<{ count: number }>();
    if (maxCount >= 0 && Number(currentCount?.count || 0) >= maxCount) throw fail.forbidden('player.limit_reached');
    throw fail.insufficientScore();
  }
  const insertedId = (result[1]?.results?.[0] as { id?: number } | undefined)?.id;
  if (!insertedId) throw fail.conflict('player.name_taken');
  const actual = await env.DB.prepare('SELECT score_paid FROM players WHERE id=?').bind(insertedId).first<{ score_paid: number }>();
  const scoreSpent = Number(actual?.score_paid || 0);
  await bumpSitemap();
  return { id: insertedId, scoreSpent };
}

// ── 改名 ─────────────────────────────────────────────────────────────────────

export async function renamePlayer(
  env: PlayerEnv,
  actor: { id: number; role: string },
  id: number,
  name: string,
  rules: NameRules,
): Promise<void> {
  assertValidName(name, rules);
  const player = await getOwnedPlayer(env, actor, id);

  const database = db(env);
  if (await repo.findPlayerByNameInsensitive(database, name, player.id)) {
    throw fail.conflict('player.name_taken');
  }
  await repo.updatePlayer(database, player.id, { name });
  if (name !== player.name) {
    const access = await import('./texture-access.ts');
    await Promise.all([access.purgePlayerProfiles(env, player.name), access.purgePlayerProfiles(env, name)]);
  }
  await bumpSitemap();
}

// ── 删除 ─────────────────────────────────────────────────────────────────────

export async function deletePlayer(
  env: PlayerEnv,
  actor: { id: number; role: string },
  id: number,
  refund: { enabled: boolean },
): Promise<void> {
  const player = await getOwnedPlayer(env, actor, id);

  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM players WHERE id=? AND user_id=? AND updated_at=? AND score_paid=? RETURNING id')
      .bind(player.id, player.userId, player.updatedAt, player.scorePaid),
    env.DB.prepare('UPDATE users SET score=score+? WHERE id=? AND changes()>0')
      .bind(refund.enabled ? player.scorePaid : 0, player.userId),
  ]);
  if (!results[0]?.meta.changes) throw fail.conflict('common.invalid_request');
  await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
  if (env.BUCKET) await (await import('./texture-access.ts')).purgeUnsharedPrivateHashes({ ...env, BUCKET: env.BUCKET }, [player.skinTextureId, player.capeTextureId]);
  await bumpSitemap();
}

// ── 指派纹理 ─────────────────────────────────────────────────────────────────

export interface AssignTexturesInput {
  skin?: number | null | undefined;
  cape?: number | null | undefined;
}

export async function assignTextures(
  env: PlayerEnv,
  actor: { id: number; role: string },
  playerId: number,
  input: AssignTexturesInput,
): Promise<void> {
  const player = await getOwnedPlayer(env, actor, playerId);
  const database = db(env);
  const patch: {
    skinTextureId?: number | null;
    capeTextureId?: number | null;
  } = {};

  for (const slot of ['skin', 'cape'] as const) {
    const raw = input[slot];
    if (raw === undefined) continue;
    const column = slot === 'skin' ? 'skinTextureId' : 'capeTextureId';

    // 0 与 null 都表示"清除"（旧库的 tid 用 0 表示无）
    if (raw === null || raw === 0) {
      patch[column] = null;
      continue;
    }

    const texture = await repo.findTextureForAssignment(database, raw);
    if (!texture) throw fail.notFound('player.texture_not_found');

    // 类型必须匹配：皮肤位不能放披风，反之亦然
    if (texture.kind !== slot) throw fail.invalid('player.texture_wrong_kind');

    // 私有纹理只有所有者或管理员能用来装扮（旧版同此）
    if (texture.visibility === 'private'
        && texture.uploaderId !== actor.id
        && !isAdmin(actor as never)) {
      throw fail.forbidden('texture.private_access_denied');
    }

    patch[column] = texture.id;
  }

  if (Object.keys(patch).length > 0) {
    await repo.updatePlayer(database, player.id, patch);
    await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
    if (env.BUCKET) await (await import('./texture-access.ts')).purgeUnsharedPrivateHashes({ ...env, BUCKET: env.BUCKET }, [
      patch.skinTextureId === undefined ? null : player.skinTextureId,
      patch.capeTextureId === undefined ? null : player.capeTextureId,
    ]);
  }
}

export async function clearTextures(
  env: PlayerEnv,
  actor: { id: number; role: string },
  playerId: number,
  which: { skin?: boolean; cape?: boolean },
): Promise<void> {
  if (!which.skin && !which.cape) throw fail.invalid();
  const player = await getOwnedPlayer(env, actor, playerId);
  const patch: { skinTextureId?: null; capeTextureId?: null } = {};
  if (which.skin) patch.skinTextureId = null;
  if (which.cape) patch.capeTextureId = null;
  await repo.updatePlayer(db(env), player.id, patch);
  await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
  if (env.BUCKET) await (await import('./texture-access.ts')).purgeUnsharedPrivateHashes({ ...env, BUCKET: env.BUCKET }, [which.skin ? player.skinTextureId : null, which.cape ? player.capeTextureId : null]);
}
