// 共享工具：错误响应、会话、设置读取。
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { hashToken, mintTokenWithHash } from '@pigeon-skin/auth';
import { LIMITS, type Role } from '@pigeon-skin/shared';
import { createDb, settings, users, sessions } from '@pigeon-skin/db';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { flag, SETTING_DEFAULTS, type Bindings, type SettingKey } from './env.ts';
import { EXTRA_DEFAULTS } from './services/settings.ts';
export { isAdmin } from './services/authorization.ts';

export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    /** 已认证用户；未登录为 null */
    user: AuthedUser | null;
    /** 本次请求的会话 id（sha256 后的），用于登出与轮换 */
    sessionId: string | null;
  };
}

export interface AuthedUser {
  readonly id: number;
  readonly email: string;
  readonly nickname: string;
  readonly role: Role;
  readonly score: number;
  readonly emailVerifiedAt: number | null;
  readonly locale: string | null;
  readonly isDarkMode: boolean;
  readonly avatarTextureId: number | null;
  readonly signature: string;
  readonly needsInitialization: boolean;
  /** 管理员禁用其提交举报（防滥用风控） */
  readonly reportingDisabled: boolean;
  /** 管理员禁用其发表评论（防滥用风控） */
  readonly commentsDisabled: boolean;
}

export type AppContext = Context<AppEnv>;
export function needsAccountInitialization(email: string, passwordHash: string, pending: boolean | number = false) {
  return !!pending || !email || !passwordHash || /@oauth\.(?:invalid|local)$/i.test(email);
}

// ── 会话 Cookie ──────────────────────────────────────────────────────────────
// 生产环境用 `__Host-` 前缀：它强制 Secure、Path=/，并**禁止 Domain 属性**，
// 从而防止被攻破的同级子域设置或读取会话 Cookie。
// 本地开发是 http，浏览器会拒绝带 Secure 的 `__Host-` Cookie，所以换一个名字。

export function sessionCookieName(env: Bindings): string {
  return env.ENVIRONMENT === 'production' ? '__Host-bs_session' : 'bs_session';
}

export function setSessionCookie(c: AppContext, token: string, maxAgeSeconds: number): void {
  setCookie(c, sessionCookieName(c.env), token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(c: AppContext): void {
  deleteCookie(c, sessionCookieName(c.env), { path: '/' });
}

// ── 会话读写 ─────────────────────────────────────────────────────────────────

/**
 * 从 Cookie 解析会话。
 *
 * 每一次认证判定都是**一次带索引的 D1 查询** —— 这是有意接受的成本：
 * 会话存在 D1 是为了强一致性（撤销即生效），把它缓存到 isolate 里
 * 会让撤销延迟一个 TTL，正好抵消选择 D1 的意义。
 */
export async function resolveSession(
  env: Bindings,
  token: string | undefined,
): Promise<{ user: AuthedUser; sessionId: string } | null> {
  if (!token) return null;
  const sessionId = await hashToken(token);
  const db = createDb(env.DB);
  const now = Date.now();

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      nickname: users.nickname,
      passwordHash: users.passwordHash,
      storedNeedsInitialization: users.needsInitialization,
      role: users.role,
      score: users.score,
      emailVerifiedAt: users.emailVerifiedAt,
      locale: users.locale,
      isDarkMode: users.isDarkMode,
      avatarTextureId: users.avatarTextureId,
      signature: users.signature,
      reportingDisabled: users.reportingDisabled,
      commentsDisabled: users.commentsDisabled,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      eq(sessions.id, sessionId),
      isNull(sessions.revokedAt),
      isNull(users.mergedIntoUserId),
      gt(sessions.expiresAt, now),
      gt(sessions.absoluteExpiresAt, now),
    ))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // 滑动续期：**最多每 15 分钟写一次**。
  // 没有这个节流的话，每个已认证请求都会写 D1，免费额度会瞬间打爆。
  if (now - row.lastSeenAt > LIMITS.sessionRenewIntervalSeconds * 1000) {
    await db.update(sessions)
      .set({ lastSeenAt: now, expiresAt: now + LIMITS.sessionIdleSeconds * 1000 })
      .where(eq(sessions.id, sessionId));
  }

  return {
    user: {
      id: row.userId,
      email: row.email,
      nickname: row.nickname,
      role: row.role as Role,
      score: row.score,
      emailVerifiedAt: row.emailVerifiedAt,
      locale: row.locale,
      isDarkMode: row.isDarkMode,
      avatarTextureId: row.avatarTextureId,
      signature: row.signature,
      reportingDisabled: !!row.reportingDisabled,
      commentsDisabled: !!row.commentsDisabled,
      needsInitialization: needsAccountInitialization(row.email, row.passwordHash, row.storedNeedsInitialization),
    },
    sessionId,
  };
}

/**
 * 创建会话。
 * 登录时**必须新建**会话而不是复用已有的 —— 这是防会话固定攻击。
 */
export async function createSession(
  env: Bindings,
  userId: number,
  meta: { ip?: string | null; userAgent?: string | null; remember?: boolean },
): Promise<{ token: string; maxAgeSeconds: number }> {
  const db = createDb(env.DB);
  const now = Date.now();
  const absoluteSeconds = meta.remember
    ? LIMITS.sessionRememberSeconds
    : LIMITS.sessionAbsoluteSeconds;
  const idleSeconds = meta.remember
    ? LIMITS.sessionRememberSeconds
    : LIMITS.sessionIdleSeconds;

  const { token, tokenHash } = await mintTokenWithHash();
  await db.insert(sessions).values({
    id: tokenHash,
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + idleSeconds * 1000,
    absoluteExpiresAt: now + absoluteSeconds * 1000,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return { token, maxAgeSeconds: absoluteSeconds };
}

export async function revokeSession(env: Bindings, sessionId: string): Promise<void> {
  const db = createDb(env.DB);
  await db.update(sessions).set({ revokedAt: Date.now() }).where(eq(sessions.id, sessionId));
}

/** 撤销某用户的全部会话（改密、重置密码、封禁时用） */
export async function revokeAllSessions(
  env: { DB: Bindings['DB'] },
  userId: number,
): Promise<void> {
  const db = createDb(env.DB);
  await db.update(sessions).set({ revokedAt: Date.now() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

// ── 设置读取 ─────────────────────────────────────────────────────────────────
// 设置几乎每个请求都要读，因此在 isolate 内缓存 60 秒。
// 写入时递增版本号、缓存键包含版本，所以管理员改动会立即在所有 isolate 生效。

let settingsCache: { values: Record<string, string>; expiresAt: number } | null = null;

/**
 * 让本 isolate 的设置缓存立即失效。
 *
 * 设置写入必须调用它，否则管理员改完之后、在 TTL 到期之前，同一个 isolate
 * 上的请求仍会读到旧值 —— 表现为"改了设置但没生效"，而且要等一分钟才自愈。
 *
 * 注意这只是**本 isolate** 的失效。其它 isolate 仍会在 TTL（60 秒）内看到旧值，
 * 这是缓存换来的代价，对站名这类展示项无影响；对计费参数也只在窗口内
 * 按旧价收费，不构成正确性问题。
 */
export function invalidateSettingsCache(): void {
  settingsCache = null;
}

export async function readSettings(env: Pick<Bindings, 'DB'>): Promise<Record<string, string>> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) return settingsCache.values;

  const db = createDb(env.DB);
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.locale, ''));

  // EXTRA_DEFAULTS（settings.ts 里仅超管可见项的默认值）也要兜底：
  // 网关等直接走 readSettings 的读取方拿不到 settings.ts 的合并结果，
  // 缺了它 ai_driver 这类 EXTRA 键会变 undefined 而不是 ''。
  const values: Record<string, string> = { ...SETTING_DEFAULTS, ...EXTRA_DEFAULTS };
  for (const r of rows) values[r.key] = r.value;

  settingsCache = { values, expiresAt: now + 60_000 };
  return values;
}

export async function getSetting(env: Pick<Bindings, 'DB'>, key: SettingKey): Promise<string> {
  const values = await readSettings(env);
  return values[key] ?? SETTING_DEFAULTS[key];
}

export async function getSettingInt(env: Pick<Bindings, 'DB'>, key: SettingKey): Promise<number> {
  const n = Number(await getSetting(env, key));
  return Number.isFinite(n) ? n : Number(SETTING_DEFAULTS[key]);
}

export async function getSettingBool(env: Pick<Bindings, 'DB'>, key: SettingKey): Promise<boolean> {
  return flag(await getSetting(env, key));
}

// ── 权限 ─────────────────────────────────────────────────────────────────────

/** 取客户端 IP。Cloudflare 设 cf-connecting-ip；Node 部署在反代后面取
 *  x-forwarded-for 的第一跳（自行直连时二者都没有，回落 unknown——
 *  与 Worker 上非 Cloudflare 请求的行为一致）。 */
export function clientIp(c: AppContext): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

/** 读取当前请求的会话 Cookie 令牌 */
export function sessionToken(c: AppContext): string | undefined {
  return getCookie(c, sessionCookieName(c.env));
}
