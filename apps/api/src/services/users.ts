// 用户资料、偏好与积分。
//
// 签到规则照抄旧版 UserController@sign 的两种并行语义：
//   rolling（默认）= 按 sign_gap_hours 滚动冷却；
//   daily = 旧版 sign_after_zero —— 每日 0 点（UTC+8）后可再签。
import { eq } from 'drizzle-orm';
import { createDb, users } from '@pigeon-skin/db';
import { hashPassword, verifyStoredPassword } from '@pigeon-skin/auth';
import { AppError, fail } from '../framework.ts';
import { isAdmin, revokeAllSessions } from '../lib.ts';
import { checkEmailDomain } from './email-policy.ts';
import * as repo from '../repositories/users.ts';
import * as textureRepo from '../repositories/textures.ts';
import type { Bindings } from '../env.ts';
import * as securityRepo from '../repositories/security.ts';
import { revokePendingTokens } from './tokens.ts';

export interface UserEnv {
  DB: Bindings['DB'];
  BUCKET?: Bindings['BUCKET'];
  APP_URL?: string;
  LEGACY_SALT?: string | undefined;
}

function db(env: UserEnv) {
  return createDb(env.DB);
}

export interface ScoreSettings {
  initialScore: number;
  signRewardMin: number;
  signRewardMax: number;
  signGapHours: number;
  perKbPublic: number;
  perKbPrivate: number;
  perPlayer: number;
  perClosetItem: number;
}

// ── 资料 ─────────────────────────────────────────────────────────────────────

export interface ProfilePatch {
  nickname?: string | undefined;
  email?: string | undefined;
  locale?: string | null | undefined;
  isDarkMode?: boolean | undefined;
  signature?: string | undefined;
}

export async function updateProfile(
  env: UserEnv,
  userId: number,
  patch: ProfilePatch,
): Promise<{ emailChanged: boolean; oldEmail: string | null }> {
  const database = db(env);
  const current = await repo.findUserProfile(database, userId);
  if (!current) throw fail.notFound('user.not_found');

  const update: Parameters<typeof repo.updateUserProfile>[2] = {};
  let emailChanged = false;

  if (patch.nickname !== undefined) update.nickname = patch.nickname;
  if (patch.locale !== undefined) update.locale = patch.locale;
  if (patch.isDarkMode !== undefined) update.isDarkMode = patch.isDarkMode;
  if (patch.signature !== undefined) update.signature = patch.signature;

  if (patch.email !== undefined && patch.email.toLowerCase() !== current.email.toLowerCase()) {
    if ((await securityRepo.methods(env, userId)).length) throw fail.forbidden('security.email_change_required');
    if (await repo.emailTakenByOther(database, patch.email, userId)) {
      throw fail.conflict('auth.email_taken');
    }
    const domainVerdict = await checkEmailDomain(env, patch.email);
    if (domainVerdict) throw fail.forbidden(domainVerdict);
    update.email = patch.email;
    // 换邮箱后原验证状态失效 —— 否则可以拿旧地址的验证状态冒充新地址已验证
    update.emailVerifiedAt = null;
    emailChanged = true;
  }

  if (Object.keys(update).length > 0) {
    try { await repo.updateUserProfile(database, userId, update); }
    catch (error) { if (String(error).includes('UNIQUE')) throw fail.conflict('auth.email_taken'); throw error; }
  }

  return { emailChanged, oldEmail: emailChanged ? current.email : null };
}

export async function changePassword(
  env: UserEnv,
  userId: number,
  currentSessionId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const database = db(env);
  const user = await repo.findUserCredentials(database, userId);
  if (!user) throw fail.notFound('user.not_found');

  const ok = !user.passwordHash || await verifyStoredPassword(input.currentPassword, user.passwordHash, {
    legacySalt: env.LEGACY_SALT ?? '',
  });
  if (!ok) throw fail.forbidden('user.invalid_current_password');

  await repo.updateUserPassword(database, userId, await hashPassword(input.newPassword));
  await revokePendingTokens(env, userId);
  // 改密码后撤销其他会话，但保留当前这个 —— 否则用户会被自己踢下线
  await repo.revokeOtherSessions(env.DB, userId, currentSessionId);
}

export async function setAvatar(
  env: UserEnv,
  actor: { id: number; role: string },
  textureId: number | null,
): Promise<void> {
  const database = db(env);

  // 0 或 null 表示清除头像，回到默认
  if (textureId === null || textureId === 0) {
    await repo.updateUserProfile(database, actor.id, { avatarTextureId: null });
    await (await import('./texture-access.ts')).purgeUserAvatar(env, actor.id);
    return;
  }

  const texture = await textureRepo.findTextureById(database, textureId);
  if (!texture) throw fail.notFound('texture.not_found');

  // 披风不能当头像（旧版同此）
  if (texture.kind !== 'skin') throw fail.invalid('player.texture_wrong_kind');

  // 别人的私有纹理不能拿来当头像
  if (texture.visibility === 'private'
      && texture.uploaderId !== actor.id
      && !isAdmin(actor as never)) {
    throw fail.forbidden('texture.private_access_denied');
  }

  await repo.updateUserProfile(database, actor.id, { avatarTextureId: texture.id });
  await (await import('./texture-access.ts')).purgeUserAvatar(env, actor.id);
}

// ── 积分与签到 ───────────────────────────────────────────────────────────────

export interface ScoreInfo {
  score: number;
  lastSignAt: number | null;
  canSignIn: boolean;
  nextSignAt: number | null;
  signReward: { min: number; max: number };
  signGapHours: number;
  usage: { players: number; storageKb: number };
  rates: {
    perKbPublic: number;
    perKbPrivate: number;
    perPlayer: number;
    perClosetItem: number;
  };
}

export async function readScoreInfo(
  env: UserEnv,
  userId: number,
  settings: ScoreSettings,
  signResetMode: string = 'rolling',
): Promise<ScoreInfo> {
  const database = db(env);
  const user = await repo.findUserProfile(database, userId);
  if (!user) throw fail.notFound('user.not_found');

  const usage = await repo.readUsage(database, userId);
  const gapMs = settings.signGapHours * 3_600_000;
  const nextSignAt = user.lastSignAt === null ? null : signResetMode === 'daily'
    ? (Math.floor((user.lastSignAt + 8 * 3_600_000) / 86_400_000) + 1) * 86_400_000 - 8 * 3_600_000
    : user.lastSignAt + gapMs;

  return {
    score: user.score,
    lastSignAt: user.lastSignAt,
    canSignIn: nextSignAt === null || nextSignAt <= Date.now(),
    nextSignAt,
    signReward: { min: settings.signRewardMin, max: settings.signRewardMax },
    signGapHours: settings.signGapHours,
    usage,
    rates: {
      perKbPublic: settings.perKbPublic,
      perKbPrivate: settings.perKbPrivate,
      perPlayer: settings.perPlayer,
      perClosetItem: settings.perClosetItem,
    },
  };
}

/**
 * 取 [min, max] 闭区间内的均匀随机整数。
 *
 * 用 CSPRNG 而不是 Math.random：奖励本身不是安全用途，但换用系统随机源的
 * 成本可以忽略，省得为"可预测的奖励"这类问题做无谓的论证。
 * 用拒绝采样而非取模，避免区间大小不整除 2^32 时的模偏差。
 */
function randomInt(min: number, max: number): number {
  const range = max - min + 1;
  if (range <= 1) return min;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0]!;
  } while (value >= limit);
  return min + (value % range);
}

/**
 * 每日签到。
 *
 * 奖励在 [min, max] 闭区间内取随机整数，与旧版对 sign_score 的处理一致
 * （旧版还允许插件用 sign_score 过滤器改写奖励，这里没有插件系统）。
 */
export async function signIn(
  env: UserEnv,
  userId: number,
  settings: ScoreSettings,
  signResetMode: string = 'rolling',
): Promise<{ reward: number; score: number }> {
  const database = db(env);
  const user = await repo.findUserProfile(database, userId);
  if (!user) throw fail.notFound('user.not_found');

  const now = Date.now();
  if (user.lastSignAt !== null) {
    if (signResetMode === 'daily') {
      // daily：每日 0 点（UTC+8）后可再签（旧版 sign_after_zero）
      const lastDay = Math.floor((user.lastSignAt + 8 * 3_600_000) / 86_400_000);
      const today = Math.floor((now + 8 * 3_600_000) / 86_400_000);
      if (lastDay === today) {
        throw new AppError('common.rate_limited', 429, '今日已签到');
      }
    } else {
      const gapMs = settings.signGapHours * 3_600_000;
      if (user.lastSignAt + gapMs > now) {
        const remainingMs = user.lastSignAt + gapMs - now;
        throw new AppError('common.rate_limited', 429,
          `距离下次签到还有 ${Math.ceil(remainingMs / 60_000)} 分钟`);
      }
    }
  }

  const { signRewardMin: min, signRewardMax: max } = settings;
  const reward = randomInt(min, max);

  const cutoff = signResetMode === 'daily'
    ? Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000 - 1
    : now - settings.signGapHours * 3_600_000;
  const score = await repo.applySignIn(env.DB, userId, reward, now, cutoff);
  if (score === null) throw new AppError('common.rate_limited', 429);
  return { reward, score };
}

// ── 注销账号 ─────────────────────────────────────────────────────────────────

/**
 * 注销自己的账号。
 *
 * 级联规则见 packages/db/migrations/0000_init.sql：players/sessions/closet/
 * notifications 跟着删；textures.uploader_id 置 NULL —— 上传的纹理会被匿名化
 * 保留，因为其他玩家可能正在穿它。
 */
export async function deleteAccount(env: UserEnv, userId: number): Promise<void> {
  const database = db(env);
  const players = await env.DB.prepare('SELECT name,skin_texture_id as skinTextureId,cape_texture_id as capeTextureId FROM players WHERE user_id=?').bind(userId).all<{ name: string; skinTextureId: number | null; capeTextureId: number | null }>();
  await database.delete(users).where(eq(users.id, userId));
  await revokeAllSessions(env, userId);
  for (const player of players.results) {
    await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
    if (env.BUCKET) await (await import('./texture-access.ts')).purgeUnsharedPrivateHashes({ ...env, BUCKET: env.BUCKET }, [player.skinTextureId, player.capeTextureId]);
  }
}
