// 认证业务规则。
//
// 两条与旧版一致、且必须保留的性质：
//   1. 登录失败不区分"无此用户"与"密码错误"，且两者耗时相当
//      （用户不存在时也执行一次等价成本的哈希运算）
//   2. 用户可以用玩家名登录，不只是邮箱
//
// 一条新架构带来的性质：旧格式的密码哈希在**首次成功登录**时立即升级为
// PBKDF2，因此旧哈希会随真实流量逐步消失，不需要批处理也不需要强制重置。
import { createDb } from '@pigeon-skin/db';
import { hashPassword, needsRehash, verifyStoredPassword } from '@pigeon-skin/auth';
import { isValidPlayerName, type PlayerNameRule } from '@pigeon-skin/shared';
import { AppError, fail } from '../framework.ts';
import { checkEmailDomain } from './email-policy.ts';
import * as repo from '../repositories/auth.ts';
import { mergeLegacyAccounts } from './account-merge.ts';
import * as securityRepo from '../repositories/security.ts';

export class EmailConflictError extends AppError {
  readonly accounts: Array<{ id: number; nickname: string }>;
  readonly requiresPasswords: number[];
  constructor(accounts: Array<{ id: number; nickname: string }>, requiresPasswords: number[]) {
    super('auth.email_conflict', 409);
    this.accounts = accounts;
    this.requiresPasswords = requiresPasswords;
  }
}
import type { Bindings } from '../env.ts';

export interface AuthEnv {
  DB: Bindings['DB'];
  LEGACY_SALT?: string | undefined;
}

function db(env: AuthEnv) {
  return createDb(env.DB);
}

export interface AuthUser {
  pendingMerge?: { retainedId: number; ids: number[] };
  id: number;
  email: string;
  nickname: string;
  role: string;
  emailVerifiedAt: number | null;
}

// ── 注册 ─────────────────────────────────────────────────────────────────────

export interface RegistrationSettings {
  enabled: boolean;
  withPlayerName: boolean;
  playerNameRule: PlayerNameRule;
  playerNameRegexp: string;
  playerNameMin: number;
  playerNameMax: number;
  regsPerIp: number;
  initialScore: number;
}

export interface RegisterInput {
  email: string;
  password: string;
  playerName?: string | undefined;
  nickname?: string | undefined;
}

export async function register(
  env: AuthEnv,
  input: RegisterInput,
  settings: RegistrationSettings,
  ip: string,
): Promise<{ userId: number }> {
  if (!settings.enabled) throw fail.forbidden('auth.registration_disabled');

  // restricted-email-domains：域名白/黑名单
  const domainVerdict = await checkEmailDomain(env, input.email);
  if (domainVerdict) throw fail.forbidden(domainVerdict);

  // 按 IP 的注册上限。旧版用 regs_per_ip = -1 表示"关闭注册"，
  // 新设计把它拆成显式的 registration_enabled 布尔，不再一值多用。
  if (settings.regsPerIp >= 0) {
    const existing = await repo.countUsersByIp(db(env), ip);
    if (existing >= settings.regsPerIp) throw fail.forbidden('auth.too_many_registrations');
  }

  const displayName = settings.withPlayerName
    ? (input.playerName ?? '')
    : (input.nickname ?? '');

  if (settings.withPlayerName) {
    const valid = isValidPlayerName(displayName, settings.playerNameRule, settings.playerNameRegexp)
      && displayName.length >= settings.playerNameMin
      && displayName.length <= settings.playerNameMax;
    if (!valid) throw fail.invalid('player.name_invalid', { player_name: 'invalid' });
  } else if (displayName.length === 0) {
    throw fail.invalid('user.nickname_invalid', { nickname: 'invalid' });
  }

  const database = db(env);

  // 唯一性由数据库的 UNIQUE ... COLLATE NOCASE 保证；这里先查一次只是为了
  // 给出干净的错误码，竞态下仍由约束兜底。
  if (await repo.findUserByEmail(database, input.email)) {
    throw fail.conflict('auth.email_taken');
  }
  if (settings.withPlayerName && await repo.playerNameExists(database, displayName)) {
    throw fail.conflict('auth.player_name_taken');
  }

  const now = Date.now();
  const passwordHash = await hashPassword(input.password);

  let results: D1Result<unknown>[];
  try {
    const statements = [env.DB.prepare(`INSERT INTO users(email,nickname,score,password_hash,registration_ip,created_at,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE ?<0 OR (SELECT COUNT(*) FROM users WHERE registration_ip=?)<? RETURNING id`)
      .bind(input.email, displayName, settings.initialScore, passwordHash, ip, now, now, settings.regsPerIp, ip, settings.regsPerIp)];
    if (settings.withPlayerName) statements.push(env.DB.prepare(`INSERT INTO players(user_id,name,score_paid,created_at,updated_at)
      SELECT last_insert_rowid(),?,0,?,? WHERE changes()>0`).bind(displayName, now, now));
    results = await env.DB.batch(statements);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw fail.conflict('auth.email_taken');
    throw e;
  }
  const userId = (results[0]?.results?.[0] as { id?: number } | undefined)?.id;
  if (!userId) throw fail.forbidden('auth.too_many_registrations');

  await repo.recordAttempt(env.DB, { ip, identifier: input.email, kind: 'register', succeeded: true });
  return { userId };
}

// ── 登录 ─────────────────────────────────────────────────────────────────────

/**
 * 用户不存在时用它做一次等价成本的哈希运算，让失败响应耗时与真实校验相当。
 * 否则响应时间就成了"这个账号是否存在"的探针。
 */
let dummyHashPromise: Promise<string> | null = null;
async function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('timing-equalizer-not-a-real-password');
  return dummyHashPromise;
}

export async function login(
  env: AuthEnv,
  input: { identifier: string; password: string; retainUserId?: number | undefined; conflictPasswords?: Array<{ userId: number; password: string }> | undefined },
  options: { ip: string; requireEmailVerification?: boolean | undefined },
): Promise<AuthUser> {
  const database = db(env);
  const ip = options.ip;

  // 含 @ 按邮箱处理，否则按玩家名（旧版就是这个判断）
  let user = input.identifier.includes('@')
    ? await repo.findUserByEmail(database, input.identifier)
    : await repo.findUserByPlayerName(database, input.identifier);

  const failLogin = async (): Promise<never> => {
    await repo.recordAttempt(env.DB, {
      ip, identifier: input.identifier, kind: 'login', succeeded: false,
    });
    throw new AppError('auth.invalid_credentials', 401);
  };

  if (!user || user.mergedIntoUserId !== null) {
    await verifyStoredPassword(input.password, await dummyHash());
    return failLogin();
  }

  let passwordVerified = false;
  let pendingMerge: AuthUser['pendingMerge'];
  const conflicts = await repo.findEmailConflicts(database, user.email);
  // 带 retainUserId 的请求是在显式解决邮箱冲突组。若组已被并发登录解决，
  // 且自己选中的账号沦为被合并方（输家），必须以 409 告知而不是悄悄登进
  // 对方保留下来的账号；选中的是赢家则按普通登录放行（页面刷新重试）。
  if (input.retainUserId && conflicts.length < 2) {
    const selected = await repo.findUserMergeState(database, input.retainUserId);
    if (!selected || selected.mergedIntoUserId !== null || selected.role === 'banned') {
      throw new AppError('auth.email_conflict', 409);
    }
  }
  if (conflicts.length > 1) {
    if (conflicts.length > 8) throw new AppError('auth.email_conflict', 409);
    const verified: number[] = [];
    for (const account of conflicts) {
      const candidatePassword = input.conflictPasswords?.find(value => value.userId === account.id)?.password ?? input.password;
      if (await verifyStoredPassword(candidatePassword, account.passwordHash, { legacySalt: env.LEGACY_SALT ?? '' })) verified.push(account.id);
    }
    if (!verified.length) return failLogin();
    const accounts = conflicts.map(account => ({ id: account.id, nickname: account.nickname }));
    const missing = conflicts.filter(account => !verified.includes(account.id)).map(account => account.id);
    if (missing.length && input.conflictPasswords?.length) await repo.recordAttempt(env.DB, { ip, identifier: input.identifier, kind: 'login', succeeded: false });
    if (!input.retainUserId || missing.length) throw new EmailConflictError(accounts, missing);
    const retained = conflicts.find(account => account.id === input.retainUserId);
    if (!retained || retained.role === 'banned') return failLogin();
    if (options.requireEmailVerification && retained.emailVerifiedAt === null) throw new AppError('auth.email_not_verified', 403);
    const protectedIds: number[] = [];
    for (const account of conflicts) if ((await securityRepo.methods(env, account.id)).length) protectedIds.push(account.id);
    if (protectedIds.length) pendingMerge = { retainedId: retained.id, ids: conflicts.map(account => account.id) };
    else await mergeLegacyAccounts(env, retained.email, retained.id, conflicts.filter(account => account.id !== retained.id).map(account => account.id));
    user = retained;
    passwordVerified = true;
  }

  const ok = passwordVerified || await verifyStoredPassword(input.conflictPasswords?.find(value => value.userId === user.id)?.password ?? input.password, user.passwordHash, {
    legacySalt: env.LEGACY_SALT ?? '',
  });
  if (!ok) return failLogin();
  if (user.role === 'banned') throw new AppError('auth.account_banned', 403);

  // 凭据正确但邮箱未验证：不记为失败尝试（不是攻击），改抛专用错误码，
  // 前端据此展示"去邮箱收验证信"界面。
  if (options.requireEmailVerification && user.emailVerifiedAt === null) {
    await repo.recordAttempt(env.DB, {
      ip, identifier: input.identifier, kind: 'login', succeeded: true,
    });
    throw new AppError('auth.email_not_verified', 403);
  }

  await repo.recordAttempt(env.DB, {
    ip, identifier: input.identifier, kind: 'login', succeeded: true,
  });

  // 旧格式（或参数偏低）的哈希在首次成功登录时立即升级
  if (needsRehash(user.passwordHash)) {
    await repo.updatePasswordHash(database, user.id, await hashPassword(input.conflictPasswords?.find(value => value.userId === user.id)?.password ?? input.password));
  }

  return {
    ...(pendingMerge ? { pendingMerge } : {}),
    id: user.id, email: user.email, nickname: user.nickname, role: user.role,
    emailVerifiedAt: user.emailVerifiedAt,
  };
}
