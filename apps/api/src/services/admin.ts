// 后台业务规则。
//
// 沿用旧版的分级规则，并补上旧版没有的会话撤销：
//   • 管理员不能操作自己，也不能操作同级或更高级别的用户
//   • super_admin **不能通过界面授予**（只能由迁移工具或直接改库设置）
//   • 封禁要连带撤销该用户全部会话，否则被封的人拿着旧 Cookie 还能继续用
import { createDb } from '@pigeon-skin/db';
import { hashPassword } from '@pigeon-skin/auth';
import { ASSIGNABLE_ROLES, canModifyUser, isSuperAdmin, type Role } from '@pigeon-skin/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { fail, type Pagination } from '../framework.ts';
import { revokeAllSessions } from '../lib.ts';
import { audit } from './audit.ts';
import { bumpSitemap } from './sitemap-cache.ts';
import { queueTextureSubmission } from './search-submissions.ts';
import * as repo from '../repositories/admin.ts';
import * as authRepo from '../repositories/auth.ts';
import * as playerRepo from '../repositories/players.ts';
import type { Bindings } from '../env.ts';
import { checkEmailDomain } from './email-policy.ts';
import { revokePendingTokens } from './tokens.ts';

export interface AdminEnv {
  DB: Bindings['DB'];
  BUCKET?: Bindings['BUCKET'];
  APP_URL?: Bindings['APP_URL'];
}
type AdminActor = { id: number; role: Role };

function db(env: AdminEnv) {
  return createDb(env.DB);
}

export async function stats(env: AdminEnv) {
  return repo.collectStats(db(env));
}

// ── 用户 ─────────────────────────────────────────────────────────────────────

export async function listUsers(
  env: AdminEnv,
  filter: { keyword?: string | undefined },
  page: Pagination,
) {
  return repo.listAdminUsers(db(env), filter, page);
}

export interface PatchUserInput {
  nickname?: string | undefined;
  email?: string | undefined;
  score?: number | undefined;
  role?: 'banned' | 'normal' | 'admin' | undefined;
  emailVerified?: boolean | undefined;
}

export async function patchUser(
  env: AdminEnv,
  actor: { id: number; role: Role },
  targetId: number,
  input: PatchUserInput,
): Promise<{ sessionsRevoked: boolean }> {
  const database = db(env);
  const target = await repo.findUserRole(database, targetId);
  if (!target) throw fail.notFound('user.not_found');

  if (target.id === actor.id) throw fail.forbidden('admin.cannot_modify_self');
  if (!canModifyUser(actor.role, target.role as Role)) {
    throw fail.forbidden('admin.cannot_modify_peer');
  }

  const patch: Record<string, unknown> = { updatedAt: Date.now() };

  if (input.nickname !== undefined) patch.nickname = input.nickname;
  let emailChanged = false;
  if (input.email !== undefined && input.email.toLowerCase() !== target.email.toLowerCase()) {
    const domainVerdict = await checkEmailDomain(env, input.email);
    if (domainVerdict) throw fail.forbidden(domainVerdict);
    patch.email = input.email;
    patch.emailVerifiedAt = null;
    emailChanged = true;
  }
  if (input.score !== undefined) patch.score = input.score;
  if (input.emailVerified !== undefined) {
    patch.emailVerifiedAt = input.emailVerified ? Date.now() : null;
  }

  let sessionsRevoked = false;
  const banPlayers = input.role === 'banned'
    ? await env.DB.prepare('SELECT name,skin_texture_id as skinTextureId,cape_texture_id as capeTextureId FROM players WHERE user_id=?').bind(targetId).all<{ name: string; skinTextureId: number | null; capeTextureId: number | null }>()
    : null;
  if (input.role !== undefined) {
    if (!ASSIGNABLE_ROLES.includes(input.role)) {
      throw fail.forbidden('admin.cannot_grant_role');
    }
    // 授予管理员需要超级管理员：最高权限不该靠一次误点达成
    if (input.role === 'admin' && !isSuperAdmin(actor.role)) {
      throw fail.forbidden('admin.cannot_grant_role');
    }
    patch.role = input.role;
    sessionsRevoked = input.role === 'banned';
  }

  try { await repo.updateUser(database, targetId, patch); }
  catch (error) { if (String(error).includes('UNIQUE')) throw fail.conflict('auth.email_taken'); throw error; }
  if (emailChanged) await revokePendingTokens(env, targetId);
  if (sessionsRevoked) {
    await revokeAllSessions(env, targetId);
    for (const player of banPlayers?.results ?? []) {
      await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
      if (env.BUCKET) await (await import('./texture-access.ts')).purgeUnsharedPrivateHashes({ ...env, BUCKET: env.BUCKET }, [player.skinTextureId, player.capeTextureId]);
    }
  }

  // 记录改了哪些字段（值本身不落日志 —— 邮箱、积分明细属于敏感数据）
  await audit(env, {
    actorId: actor.id,
    action: 'admin.user.update',
    targetType: 'user',
    targetId,
    detail: `fields:${Object.keys(patch).filter((k) => k !== 'updatedAt').join(',')}`,
  });

  return { sessionsRevoked };
}

export async function deleteUser(
  env: AdminEnv,
  actor: { id: number; role: Role },
  targetId: number,
): Promise<void> {
  if (targetId === actor.id) throw fail.forbidden('admin.cannot_modify_self');

  const database = db(env);
  const target = await repo.findUserRole(database, targetId);
  if (!target) throw fail.notFound('user.not_found');
  if (!canModifyUser(actor.role, target.role as Role)) {
    throw fail.forbidden('admin.cannot_modify_peer');
  }

  const playerRows = await env.DB.prepare('SELECT name,skin_texture_id as skinTextureId,cape_texture_id as capeTextureId FROM players WHERE user_id=?').bind(targetId).all<{ name: string; skinTextureId: number | null; capeTextureId: number | null }>();

  // 级联规则见 packages/db/migrations/0000_init.sql：
  // players/sessions/notifications/closet 级联删除；
  // textures.uploader_id 与 players 的纹理引用置 NULL —— 删除用户不应销毁
  // 其他玩家正在使用的纹理，所以那些纹理被匿名化保留。
  await repo.deleteUser(database, targetId);
  for (const player of playerRows.results) {
    await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
    if (env.BUCKET) await (await import('./texture-access.ts')).purgeUnsharedPrivateHashes({ ...env, BUCKET: env.BUCKET }, [player.skinTextureId, player.capeTextureId]);
  }
  await audit(env, {
    actorId: actor.id, action: 'admin.user.delete', targetType: 'user', targetId,
    detail: `role:${target.role}`,
  });
}

// ── 纹理 ─────────────────────────────────────────────────────────────────────

export async function listTextures(
  env: AdminEnv,
  filter: { keyword?: string | undefined },
  page: Pagination,
) {
  return repo.listAdminTextures(db(env), filter, page);
}

// ── 收藏（后台视角）────────────────────────────────────────────────────────

export async function listUserCloset(env: AdminEnv, userId: number, page: Pagination) {
  return repo.listUserCloset(db(env), userId, page);
}

/**
 * 管理员代删用户的收藏条目。不退积分 —— 那是用户自己的钱，
 * 管理员的删除是内容治理动作，不是交易回滚；要补偿可以用 patchUser 加分。
 */
export async function deleteUserClosetEntry(
  env: AdminEnv,
  actor: AdminActor,
  userId: number,
  textureId: number,
): Promise<void> {
  const database = db(env);
  const owner = await repo.findUserRole(database, userId);
  if (!owner) throw fail.notFound('user.not_found');
  if (!canModifyUser(actor.role, owner.role as Role)) throw fail.forbidden('admin.cannot_modify_peer');
  if (!await repo.adminDeleteClosetEntry(database, userId, textureId)) {
    throw fail.notFound('closet.not_found');
  }
  await audit(env, {
    actorId: actor.id, action: 'admin.closet.delete',
    targetType: 'user', targetId: userId,
    detail: `texture:${textureId}`,
  });
}

// ── 玩家 ─────────────────────────────────────────────────────────────────────

export async function listPlayers(
  env: AdminEnv,
  filter: { keyword?: string | undefined },
  page: Pagination,
) {
  return repo.listAdminPlayers(db(env), filter, page);
}

export async function patchPlayer(
  env: AdminEnv,
  actor: AdminActor,
  playerId: number,
  input: { name?: string | undefined; ownerId?: number | undefined; skin?: number | null | undefined; cape?: number | null | undefined },
): Promise<void> {
  const database = db(env);
  const player = await repo.findAnyPlayer(database, playerId);
  if (!player) throw fail.notFound('player.not_found');
  if (!canModifyUser(actor.role, player.ownerRole as Role)) throw fail.forbidden('admin.cannot_modify_peer');

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.ownerId !== undefined) {
    const targetOwner = await repo.findUserRole(database, input.ownerId);
    if (!targetOwner) throw fail.notFound('user.not_found');
    if (targetOwner.id !== actor.id && !canModifyUser(actor.role, targetOwner.role as Role)) throw fail.forbidden('admin.cannot_modify_peer');
    patch.userId = input.ownerId;
    patch.scorePaid = 0;
  }
  for (const kind of ['skin', 'cape'] as const) {
    const textureId = input[kind];
    if (textureId === undefined) continue;
    if (textureId) {
      const texture = await playerRepo.findTextureForAssignment(database, textureId);
      if (!texture) throw fail.notFound('player.texture_not_found');
      if (texture.kind !== kind) throw fail.invalid('player.texture_wrong_kind');
      if (texture.visibility !== 'public') throw fail.forbidden('texture.private_access_denied');
    }
    patch[kind === 'skin' ? 'skinTextureId' : 'capeTextureId'] = textureId || null;
  }

  try {
    await repo.updateAnyPlayer(database, playerId, patch);
  } catch (e) {
    // 换名可能撞 UNIQUE(name COLLATE NOCASE)
    if (String(e).includes('UNIQUE')) throw fail.conflict('player.name_taken');
    throw e;
  }
  await audit(env, {
    actorId: actor.id, action: 'admin.player.update',
    targetType: 'player', targetId: playerId,
    detail: `fields:${Object.keys(patch).join(',')}`,
  });
  await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
  if (env.BUCKET) await (await import('./texture-access.ts')).purgeUnsharedPrivateHashes({ ...env, BUCKET: env.BUCKET }, [
    input.skin !== undefined ? player.skinTextureId : null,
    input.cape !== undefined ? player.capeTextureId : null,
  ]);
  await bumpSitemap();
}

export async function deletePlayer(
  env: AdminEnv,
  actor: AdminActor,
  playerId: number,
): Promise<void> {
  const database = db(env);
  const player = await repo.findAnyPlayer(database, playerId);
  if (!player) throw fail.notFound('player.not_found');
  if (!canModifyUser(actor.role, player.ownerRole as Role)) throw fail.forbidden('admin.cannot_modify_peer');
  await repo.deleteAnyPlayer(database, playerId);
  await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
  if (env.BUCKET) await (await import('./texture-access.ts')).purgeUnsharedPrivateHashes({ ...env, BUCKET: env.BUCKET }, [player.skinTextureId, player.capeTextureId]);
  await audit(env, {
    actorId: actor.id, action: 'admin.player.delete',
    targetType: 'player', targetId: playerId,
  });
  await bumpSitemap();
}

// ── 重置用户密码 ─────────────────────────────────────────────────────────────

/**
 * 管理员重置用户密码：生成随机临时密码，撤销该用户全部会话，写审计。
 *
 * 返回临时密码给管理员转告。生成而不是让管理员指定 —— 管理员不该知道
 * 用户的长期密码，临时密码本来就要在下次登录后改掉（needsRehash 不触发，
 * 因为它已是 pbkdf2，用户改密码前一直用它是可接受的妥协）。
 */
export async function resetUserPassword(
  env: AdminEnv,
  actor: { id: number; role: Role },
  targetId: number,
): Promise<string> {
  const database = db(env);
  const target = await repo.findUserRole(database, targetId);
  if (!target) throw fail.notFound('user.not_found');
  if (target.id === actor.id) throw fail.forbidden('admin.cannot_modify_self');
  if (!canModifyUser(actor.role, target.role as Role)) {
    throw fail.forbidden('admin.cannot_modify_peer');
  }

  // 用 crypto.getRandomValues 生成 12 位可读密码（无易混淆字符）。
  // 拒绝采样消除取模偏差 —— 同 services/users.ts signIn() 的做法。
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let password = '';
  while (password.length < 12) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    for (const b of bytes) {
      if (b >= limit) continue;
      password += alphabet[b % alphabet.length]!;
      if (password.length === 12) break;
    }
  }

  await repo.updateUser(database, targetId, {
    passwordHash: await hashPassword(password),
    updatedAt: Date.now(),
  });
  await revokePendingTokens(env, targetId);
  await revokeAllSessions(env, targetId);

  await audit(env, {
    actorId: actor.id, action: 'admin.user.reset_password', targetType: 'user', targetId,
  });

  return password;
}

// ── 群发通知 ─────────────────────────────────────────────────────────────────

export async function broadcast(
  env: AdminEnv,
  input: { title: string; content?: string | undefined; receiver: 'all' | 'normal' | number | string },
): Promise<{ sent: number }> {
  const database = db(env);
  const sent = await repo.countRecipients(database, input.receiver);
  if (sent === 0) return { sent: 0 };

  await repo.broadcastStatement(env.DB, input.receiver, {
    title: input.title,
    body: input.content ?? '',
    createdAt: Date.now(),
  }).run();

  return { sent };
}

export async function broadcastRecipients(env: AdminEnv, receiver: 'all' | 'normal' | number | string) {
  return repo.listBroadcastRecipients(db(env), receiver);
}

// ── Phase A 补齐：建号 / 纹理治理 / 审计 / 会话 ──────────────────────────────

/** 管理员创建用户（PHP 版没有此功能，是运维高频诉求；role 遵循 ASSIGNABLE_ROLES） */
export async function createUser(
  env: AdminEnv,
  actor: { id: number; role: Role },
  input: { email: string; nickname: string; password: string; role?: 'banned' | 'normal' | 'admin' },
): Promise<{ id: number }> {
  const database = db(env);
  if (await authRepo.findUserByEmail(database, input.email)) {
    throw fail.conflict('auth.email_taken');
  }
  const { hashPassword } = await import('@pigeon-skin/auth');
  const now = Date.now();
  let userId: number;
  try {
    userId = await authRepo.insertUser(database, {
      email: input.email,
      nickname: input.nickname,
      score: 0,
      passwordHash: await hashPassword(input.password),
      registrationIp: null as unknown as string,
      createdAt: now,
    });
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw fail.conflict('auth.email_taken');
    throw e;
  }
  if (input.role && input.role !== 'normal') {
    // 授予 admin 仍需超管，与 patchUser 同规则
    if (input.role === 'admin' && !isSuperAdmin(actor.role)) {
      throw fail.forbidden('admin.cannot_grant_role');
    }
    await repo.updateUser(database, userId, { role: input.role, updatedAt: now });
  }
  await audit(env, {
    actorId: actor.id, action: 'admin.user.create', targetType: 'user', targetId: userId,
    detail: `email:${input.email}`,
  });
  return { id: userId };
}

/** 后台纹理治理：删除（复用用户侧删除的引用计数/R2 逻辑，不退分） */
export async function deleteAnyTexture(env: AdminEnv, actor: { id: number; role: Role }, textureId: number): Promise<void> {
  const database = db(env);
  const texture = await (await import('../repositories/textures.ts')).findTextureById(database, textureId);
  if (!texture) throw fail.notFound('texture.not_found');
  if (texture.uploaderId !== null) {
    const owner = await repo.findUserRole(database, texture.uploaderId);
    if (owner && !canModifyUser(actor.role, owner.role as Role)) throw fail.forbidden('admin.cannot_modify_peer');
  }

  await (await import('../repositories/textures.ts')).deleteTexture(database, textureId);
  const remaining = await (await import('../repositories/textures.ts')).countReferencesToHash(database, texture.hash);
  if (remaining === 0 && env.BUCKET) {
    const { textureObjectKey } = await import('@pigeon-skin/minecraft');
    await env.BUCKET.delete(textureObjectKey(texture.hash));
  }
  if (env.BUCKET && !(await (await import('../repositories/textures.ts')).countPublicReferencesToHash(database, texture.hash))) {
    await (await import('./texture-access.ts')).purgeTextureDerivatives({ ...env, BUCKET: env.BUCKET }, texture.hash);
  }
  await audit(env, {
    actorId: actor.id, action: 'admin.texture.delete', targetType: 'texture', targetId: textureId,
    detail: `hash:${texture.hash}`,
  });
  await bumpSitemap();
  await queueTextureSubmission(env, textureId);
}

/** 后台纹理治理：改可见性（不结算差价 —— 治理动作，同代删收藏哲学） */
export async function patchAnyTexture(
  env: AdminEnv,
  actor: { id: number; role: Role },
  textureId: number,
  patch: { name?: string; visibility?: 'public' | 'private' },
): Promise<void> {
  const database = db(env);
  const texture = await (await import('../repositories/textures.ts')).findTextureById(database, textureId);
  if (!texture) throw fail.notFound('texture.not_found');
  if (texture.uploaderId !== null) {
    const owner = await repo.findUserRole(database, texture.uploaderId);
    if (owner && !canModifyUser(actor.role, owner.role as Role)) throw fail.forbidden('admin.cannot_modify_peer');
  }
  const update: { name?: string; visibility?: 'public' | 'private'; updatedAt: number } = {
    updatedAt: Date.now(),
  };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.visibility !== undefined) update.visibility = patch.visibility;
  await (await import('../repositories/textures.ts')).updateTexture(database, textureId, update);
  if (patch.visibility === 'private' && !(await (await import('../repositories/textures.ts')).countPublicReferencesToHash(database, texture.hash)) && env.BUCKET) {
    await (await import('./texture-access.ts')).purgeTextureDerivatives({ ...env, BUCKET: env.BUCKET }, texture.hash);
  }
  await audit(env, {
    actorId: actor.id, action: 'admin.texture.update', targetType: 'texture', targetId: textureId,
    detail: `fields:${Object.keys(update).filter((k) => k !== 'updatedAt').join(',')}`,
  });
  await bumpSitemap();
  await queueTextureSubmission(env, textureId);
}

/** 审计日志查询（分页 + action/actor 过滤） */
export async function listAuditLog(
  env: AdminEnv,
  filter: { action?: string; actorId?: number },
  page: import('../framework.ts').Pagination,
): Promise<{ items: unknown[]; total: number }> {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (filter.action) { conditions.push('a.action = ?'); binds.push(filter.action); }
  if (filter.actorId !== undefined) { conditions.push('a.actor_id = ?'); binds.push(filter.actorId); }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await env.DB
    .prepare(`SELECT a.id, a.actor_id AS actorId, a.action, a.target_type AS targetType,
              a.target_id AS targetId, a.detail, a.created_at AS createdAt,
              u.email AS actorEmail
              FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
              ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, page.perPage, page.offset).all();
  const countRows = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM audit_log a ${whereSql}`)
    .bind(...binds).first<{ n: number }>();
  return { items: rows.results ?? [], total: countRows?.n ?? 0 };
}

/** 查目标用户角色（供路由层做层级校验） */
export async function findUserRole(env: AdminEnv, userId: number): Promise<{ id: number; role: string } | null> {
  return await repo.findUserRole(db(env), userId);
}

/** 某用户的活跃会话（不含已吊销/过期） */
export async function listUserSessions(
  env: AdminEnv,
  userId: number,
): Promise<Array<{ id: string; createdAt: number; lastSeenAt: number; ip: string | null; userAgent: string | null }>> {
  const database = db(env);
  const { sessions } = await import('@pigeon-skin/db');
  const now = Date.now();
  return await database
    .select({
      id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt,
      ip: sessions.ip, userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(50);
}

/** 吊销某用户全部会话 */
export async function revokeUserSessions(
  env: AdminEnv,
  actor: { id: number; role: Role },
  targetId: number,
): Promise<void> {
  const target = await repo.findUserRole(db(env), targetId);
  if (!target) throw fail.notFound('user.not_found');
  if (!canModifyUser(actor.role, target.role as Role)) {
    throw fail.forbidden('admin.cannot_modify_peer');
  }
  await revokeAllSessions(env, targetId);
  await audit(env, {
    actorId: actor.id, action: 'admin.user.revoke_sessions', targetType: 'user', targetId,
  });
}
