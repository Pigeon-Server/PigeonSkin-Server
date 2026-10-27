// 后台业务规则。
//
// 沿用旧版的分级规则，并补上旧版没有的会话撤销：
//   • 管理员不能操作自己，也不能操作同级或更高级别的用户
//   • super_admin **不能通过界面授予**（只能由迁移工具或直接改库设置）
//   • 封禁要连带撤销该用户全部会话，否则被封的人拿着旧 Cookie 还能继续用
import { type Bindings } from './../core/env.ts';
import { fail, type Pagination } from './../core/framework.ts';
import { revokeAllSessions } from './../core/session.ts';
import { getSetting, readSettings } from './../core/settings-reader.ts';
import { createDb, notificationTranslations } from '@pigeon-skin/db';
import { computePasswordHash } from './compute.ts';
import { ASSIGNABLE_ROLES, canModifyUser, isSuperAdmin, type Role } from '@pigeon-skin/shared';
import { decodePng, detectSkinModel, textureObjectKey, HARD_TEXTURE_MAX_AREA } from '@pigeon-skin/minecraft';
import { and, eq, gt, isNull } from 'drizzle-orm';

import { audit, auditBatch } from './audit.ts';
import { bumpSitemap } from './sitemap-cache.ts';
import { queueTextureSubmission, queueTextureSubmissions } from './search-submissions.ts';
import { renderNotificationTemplate } from './notification-template.ts';
import { contentHash } from './notifications.ts';
import { enqueueAiJob } from './ai-jobs.ts';
import * as repo from '../repositories/admin.ts';
import * as authRepo from '../repositories/auth.ts';
import * as playerRepo from '../repositories/players.ts';

import { checkEmailDomain } from './email-policy.ts';
import type { SqlFragment } from '../search/compile.ts';
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
  filter: { search?: SqlFragment | null | undefined },
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
  reportingDisabled?: boolean | undefined;
  commentsDisabled?: boolean | undefined;
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
  if (input.reportingDisabled !== undefined) patch.reportingDisabled = input.reportingDisabled;
  if (input.commentsDisabled !== undefined) patch.commentsDisabled = input.commentsDisabled;
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
  // 名下角色 uuid 随级联消失，删除前先取出、删除成功后归档（同名重建复用旧 UUID）
  const profiles = await import('./ygg-profiles.ts');
  const archivedUuids = await profiles.userUuidEntries(env.DB, targetId);
  await repo.deleteUser(database, targetId);
  await profiles.insertUuidArchive(env.DB, archivedUuids);
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
  filter: { search?: SqlFragment | null | undefined; kind?: string | undefined; visibility?: string | undefined; official?: boolean | undefined },
  page: Pagination,
) {
  return repo.listAdminTextures(db(env), filter, page);
}

export type TextureBatchAction = 'delete' | 'visibility';

/**
 * 批量治理材质：删除，或批量改可见性。
 *
 * 业务语义与逐条 deleteAnyTexture / patchAnyTexture 完全对齐（越权拒绝、
 * 穿戴者指纹前进、R2 按引用计数删对象、衍生图清理、sitemap 与搜索队列），
 * 区别只在清理动作按批各做一次。逐条调用在批量下会把子请求数乘上选中条数，
 * 一个整页删除就能撞上 Workers 的子请求上限。
 *
 * 任一目标越权则整批拒绝：部分成功会让管理员以为整批都生效了。
 */
export async function batchTextures(
  env: AdminEnv,
  actor: AdminActor,
  action: TextureBatchAction,
  ids: readonly number[],
  visibility?: 'public' | 'private',
): Promise<{ affected: number }> {
  const unique = [...new Set(ids)];
  if (!unique.length) throw fail.invalid('common.invalid_request');
  if (action === 'visibility' && visibility === undefined) throw fail.invalid('common.invalid_request');

  const database = db(env);
  const targets = await repo.findAdminTexturesByIds(database, unique);
  if (!targets.length) throw fail.notFound('texture.not_found');

  // 上传者已注销（uploader_id 为空）的材质视为无主，管理员可直接治理
  const ownerIds = [...new Set(targets.map(t => t.uploaderId).filter((id): id is number => id !== null))];
  if (ownerIds.length) {
    const roles = new Map((await repo.findUserRolesByIds(database, ownerIds)).map(row => [row.id, row.role as Role]));
    for (const role of roles.values()) {
      if (!canModifyUser(actor.role, role)) throw fail.forbidden('admin.cannot_modify_peer');
    }
  }

  const targetIds = targets.map(t => t.id);
  const hashes = [...new Set(targets.map(t => t.hash))];
  const now = Date.now();
  const access = await import('./texture-access.ts');

  // 删除会让外键把角色行的指针置空 —— 资料内容变了而角色行指纹不会自己变，
  // 必须在这之前把穿戴者的 updated_at 推走，否则客户端带旧 ETag 重验证会
  // 拿到 304、继续用已删除的哈希。改可见性不动角色资料，无需推进（与逐条
  // patchAnyTexture 一致：私密材质被角色穿着时仍对游戏可达）。
  const wearing = action === 'delete'
    ? await repo.listPlayersWearingTextures(database, targetIds)
    : new Map<number, string[]>();
  if (action === 'delete') await repo.touchPlayersWearingTextures(database, targetIds, now);

  if (action === 'delete') {
    await repo.deleteAiJobsForTextures(database, targetIds);
    await repo.deleteAdminTextures(database, targetIds);
  } else {
    await repo.setAdminTexturesVisibility(database, targetIds, visibility!, now);
  }

  for (const names of wearing.values()) {
    for (const name of names) await access.purgePlayerProfiles(env, name);
  }

  const textureRepo = await import('../repositories/textures.ts');
  if (action === 'delete' && env.BUCKET) {
    // 同一对象可能被多行共享，引用计数必须在删除**之后**、且对本批哈希一次性算出
    const remaining = await textureRepo.countReferencesToHashes(database, hashes);
    const orphaned = hashes.filter(hash => (remaining.get(hash) ?? 0) === 0);
    if (orphaned.length) {
      const { textureObjectKey } = await import('@pigeon-skin/minecraft');
      await env.BUCKET.delete(orphaned.map(hash => textureObjectKey(hash)));
    }
  }
  if (env.BUCKET) {
    // 还有别处公开引用同一哈希时不能清衍生图：那张预览图是它们共用的
    const stillPublic = await textureRepo.countPublicReferencesToHashes(database, hashes);
    for (const hash of hashes.filter(h => (stillPublic.get(h) ?? 0) === 0)) {
      await access.purgeTextureDerivatives({ ...env, BUCKET: env.BUCKET }, hash);
    }
  }

  const actionName = action === 'delete' ? 'admin.texture.delete' as const : 'admin.texture.update' as const;
  await auditBatch(env, targets.map(target => ({
    actorId: actor.id,
    action: actionName,
    targetType: 'texture',
    targetId: target.id,
    detail: action === 'delete' ? `hash:${target.hash}` : `visibility:${visibility}`,
  })));

  await bumpSitemap(env);
  await queueTextureSubmissions(env, targetIds);
  return { affected: targets.length };
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
  filter: { search?: SqlFragment | null | undefined },
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
  await bumpSitemap(env);
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
  // uuid 行随外键级联消失，删除前先取出、删除成功后归档（同名重建复用旧 UUID）
  const profiles = await import('./ygg-profiles.ts');
  const archived = await profiles.playerUuidEntry(env.DB, playerId);
  await repo.deleteAnyPlayer(database, playerId);
  if (archived) await profiles.insertUuidArchive(env.DB, [archived]);
  await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
  if (env.BUCKET) await (await import('./texture-access.ts')).purgeUnsharedPrivateHashes({ ...env, BUCKET: env.BUCKET }, [player.skinTextureId, player.capeTextureId]);
  await audit(env, {
    actorId: actor.id, action: 'admin.player.delete',
    targetType: 'player', targetId: playerId,
  });
  await bumpSitemap(env);
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
    passwordHash: await computePasswordHash(env, password),
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
  const recipients = await repo.listBroadcastRecipients(database, input.receiver);
  if (recipients.length === 0) return { sent: 0 };

  // 模板变量按收件人逐个渲染（{{player}}/{{email}}/{{uid}}/{{score}} 因人而异），
  // 因此必须逐行插入而不能一条 INSERT…SELECT。站点名/地址是全局值，取一次。
  // site_url 是 EXTRA_SETTINGS 键（不在 SETTING_DEFAULTS），走 readSettings 取。
  const [siteName, settingsValues] = await Promise.all([getSetting(env, 'site_name'), readSettings(env)]);
  const siteContext = { siteName: siteName || 'Pigeon Skin Server', siteUrl: settingsValues.site_url ?? '' };
  const playerNames = await repo.listBroadcastPlayerNames(database, input.receiver);
  const now = Date.now();
  // 骨架哈希在写入时就落到行上（渲染后的文本无法反推骨架），读取端直接匹配
  const templateHash = String(contentHash(input.title, input.content ?? ''));
  const rendered = recipients.map((r) => ({
    userId: r.id,
    title: renderNotificationTemplate(input.title, { ...siteContext, player: playerNames.get(r.id) ?? '', email: r.email, uid: r.id, score: r.score }, now),
    body: renderNotificationTemplate(input.content ?? '', { ...siteContext, player: playerNames.get(r.id) ?? '', email: r.email, uid: r.id, score: r.score }, now),
    createdAt: now,
    templateHash,
  }));
  // 大群体（全体群发可达数万行）分批插入：D1 单语句绑定上限 100,每行 6 列
  // → 每条语句最多 16 行;再以 batch() 打包,一次往返提交、子请求数只按 1 计
  const BATCH = 16;
  for (let i = 0; i < rendered.length; i += BATCH * 10) {
    const chunk = rendered.slice(i, i + BATCH * 10);
    const statements: D1PreparedStatement[] = [];
    for (let j = 0; j < chunk.length; j += BATCH) {
      const rows = chunk.slice(j, j + BATCH);
      const values = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
      statements.push(env.DB.prepare(`INSERT INTO notifications (user_id, type, title, body, created_at, template_hash) VALUES ${values}`)
        .bind(...rows.flatMap(row => [row.userId, 'site_message', row.title, row.body, row.createdAt, row.templateHash])));
    }
    await env.DB.batch(statements);
  }

  // AI 翻译以「模板骨架」（变量未渲染的管理员原文）为键：无论发给多少人，
  // 一个模板只翻译一次。先写骨架源行（译文列为空，locale='' 哨兵），执行器
  // 据此调用 AI 并按 locale 写译文。入队失败不阻塞发送 —— 译文缺失只是回退原文。
  try {
    const aiEnabled = (await getSetting(env, 'notification_ai_translation')) === 'true';
    await database.insert(notificationTranslations).values({
      locale: '', contentHash: templateHash,
      sourceTitle: input.title, sourceBody: input.content ?? '',
      title: '', body: '', createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [notificationTranslations.contentHash, notificationTranslations.locale],
      set: { sourceTitle: input.title, sourceBody: input.content ?? '', updatedAt: now },
    });
    await enqueueAiJob(env, 'translate_notification', Number(templateHash), { enabled: aiEnabled });
  } catch (e) {
    console.error('通知翻译任务入队失败（不影响发送）', e);
  }

  return { sent: rendered.length };
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
  const now = Date.now();
  let userId: number;
  try {
    userId = await authRepo.insertUser(database, {
      email: input.email,
      nickname: input.nickname,
      score: 0,
      passwordHash: await computePasswordHash(env, input.password),
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

  // 与用户侧删除同一套语义（见 services/textures.ts deleteTexture）：删除前先
  // 推进穿戴者的 updated_at，否则客户端带旧 ETag 重验证会 304 继续用已删除的哈希。
  const access = await import('./texture-access.ts');
  const wearingPlayers = await access.playersWearingTexture(env, textureId, Date.now());
  // ai_jobs 没有外键，不随材质级联：留着会变成永远失败的僵尸任务（用户侧删除也清）
  await repo.deleteAiJobsForTextures(database, [textureId]);
  await (await import('../repositories/textures.ts')).deleteTexture(database, textureId);
  for (const name of wearingPlayers) await access.purgePlayerProfiles(env, name);
  const remaining = await (await import('../repositories/textures.ts')).countReferencesToHash(database, texture.hash);
  if (remaining === 0 && env.BUCKET) {
    const { textureObjectKey } = await import('@pigeon-skin/minecraft');
    await env.BUCKET.delete(textureObjectKey(texture.hash));
  }
  if (env.BUCKET && !(await (await import('../repositories/textures.ts')).countPublicReferencesToHash(database, texture.hash))) {
    await access.purgeTextureDerivatives({ ...env, BUCKET: env.BUCKET }, texture.hash);
  }
  await audit(env, {
    actorId: actor.id, action: 'admin.texture.delete', targetType: 'texture', targetId: textureId,
    detail: `hash:${texture.hash}`,
  });
  await bumpSitemap(env);
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
  await bumpSitemap(env);
  await queueTextureSubmission(env, textureId);
}

/**
 * 存量皮肤模型重检：模型一度由用户手选、可能标错，按像素重新判定。
 * 变化的行推进 updated_at 并清角色协议缓存、删衍生图 —— 与 patchTexture
 * 类型变更走同一套失效路径（texture_counts 触发器自动跟随，无需处理）。
 * 游标分批，由 tools 脚本驱动跑完全量；批内逐条顺序处理。
 */
export async function redetectSkinModels(
  env: AdminEnv & { BUCKET: NonNullable<AdminEnv['BUCKET']> },
  actor: AdminActor,
  options: { lastId: number; limit: number },
): Promise<{ processed: number; changed: number; skipped: number; nextCursor: number | null }> {
  const { results } = await env.DB
    .prepare('SELECT id, hash, model FROM textures WHERE kind = ? AND id > ? ORDER BY id LIMIT ?')
    .bind('skin', options.lastId, options.limit)
    .all<{ id: number; hash: string; model: string | null }>();
  const { playersWearingTexture, purgePlayerProfiles, purgeTextureDerivatives } = await import('./texture-access.ts');
  let changed = 0;
  let skipped = 0;
  const changedHashes: string[] = [];
  for (const row of results) {
    const object = await env.BUCKET.get(textureObjectKey(row.hash));
    const decoded = object ? await decodePng(new Uint8Array(await object.arrayBuffer()), HARD_TEXTURE_MAX_AREA) : null;
    if (!decoded?.ok) { skipped++; continue; }
    const detected = detectSkinModel(decoded.image.width, decoded.image.height, decoded.image.rgba);
    if (detected === (row.model ?? 'default')) continue;
    // 先推进穿戴者指纹再改行：/{name}.json 的 ETag 取自 players.updated_at，
    // 不推进则客户端带旧 ETag 重验证拿到 304，继续用旧模型渲染的资料
    for (const name of await playersWearingTexture(env, row.id, Date.now())) await purgePlayerProfiles(env, name);
    await env.DB.prepare('UPDATE textures SET model = ?, updated_at = ? WHERE id = ?').bind(detected, Date.now(), row.id).run();
    await purgeTextureDerivatives(env, row.hash);
    await queueTextureSubmission(env, row.id);
    changed++;
    changedHashes.push(row.hash.slice(0, 12));
  }
  if (changed > 0) {
    await audit(env, {
      actorId: actor.id,
      action: 'admin.texture.model.redetect',
      detail: `lastId:${options.lastId} changed:${changed} skipped:${skipped} hashes:${changedHashes.slice(0, 5).join(',')}`,
    });
  }
  const last = results.at(-1);
  return { processed: results.length, changed, skipped, nextCursor: last ? last.id : null };
}

/** 审计日志查询（分页 + action/actor 过滤） */
export async function listAuditLog(
  env: AdminEnv,
  filter: { action?: string; actorId?: number; search?: SqlFragment | null },
  page: import('../core/framework.ts').Pagination,
): Promise<{ items: unknown[]; total: number }> {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (filter.action) { conditions.push('a.action = ?'); binds.push(filter.action); }
  if (filter.actorId !== undefined) { conditions.push('a.actor_id = ?'); binds.push(filter.actorId); }
  if (filter.search) { conditions.push(filter.search.sql); binds.push(...filter.search.params); }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await env.DB
    .prepare(`SELECT a.id, a.actor_id AS actorId, a.action, a.target_type AS targetType,
              a.target_id AS targetId, a.detail, a.created_at AS createdAt,
              u.email AS actorEmail
              FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
              ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, page.perPage, page.offset).all();
  // 计数与列表共用同一套 join：表达式可能引用 u.email
  const countRows = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ${whereSql}`)
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
