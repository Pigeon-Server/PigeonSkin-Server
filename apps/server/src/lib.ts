// 共享工具：错误响应、会话、设置读取。
import type { Context } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { mintTokenWithHash, mintWebAccessToken, verifyWebAccessToken } from '@pigeon-skin/auth';
import { LIMITS, type Role } from '@pigeon-skin/shared';
import { createDb, settings, users, sessions } from '@pigeon-skin/db';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { flag, SETTING_DEFAULTS, type Bindings, type SettingKey } from './env.ts';
import { bumpCacheGeneration, currentCacheGeneration } from './cache-generation.ts';
import { invalidateCachedSession, invalidateCachedSessionsOf } from './lib/auth-cache.ts';
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

/**
 * 对外暴露的用户字段序列化 —— **所有**把 user 放进 JSON 响应的出口都必须
 * 经过它。密码哈希等敏感列绝不出现；前端期望的是 emailVerified 布尔
 * （AuthedUser 的 emailVerifiedAt 是内部时间戳，直接透传会变成字段缺失）。
 */
export function toPublicUser(user: AuthedUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    role: user.role,
    score: user.score,
    emailVerified: user.emailVerifiedAt !== null,
    locale: user.locale,
    isDarkMode: user.isDarkMode,
    avatarTextureId: user.avatarTextureId,
    needsInitialization: user.needsInitialization,
    reportingDisabled: user.reportingDisabled,
    commentsDisabled: user.commentsDisabled,
  };
}

// ── 会话令牌 ─────────────────────────────────────────────────────────────────
// Web 前端认证是双令牌：
//   • access token —— 短时效 JWT（HS256 / SESSION_SECRET），前端存 localStorage，
//     每请求经 Authorization 头本地验签，不查库；
//   • refresh token —— 不透明随机令牌，SHA-256 存 D1 sessions 表（沿用旧表），
//     前端凭它换新 access token。
// 撤销/封禁/改密等会话语义全部落在 sessions 行上，与旧 cookie 方案一致。
//
// 旧方案遗留的 Cookie 名称仅保留给登出清理存量 `__Host-bs_session` 用，
// 服务端不再读写它。

export function sessionCookieName(env: Bindings): string {
  return env.ENVIRONMENT === 'production' ? '__Host-bs_session' : 'bs_session';
}

export function clearSessionCookie(c: AppContext): void {
  const secure = c.env.ENVIRONMENT === 'production';
  // `__Host-` 前缀的 Cookie 在 cookie 序列化层强制要求 Secure 属性，
  // 删除时也必须带上，否则序列化直接抛错导致登出 500。
  deleteCookie(c, sessionCookieName(c.env), { path: '/', secure });
}

// ── 会话读写 ─────────────────────────────────────────────────────────────────

export interface SessionRecord {
  user: AuthedUser;
  /** 会话 id = refresh 令牌的 SHA-256（sessions.id），JWT 的 sid claim */
  sessionId: string;
  lastSeenAt: number;
}

/**
 * 按会话 id 加载认证用户。
 *
 * 这是认证路径里唯一需要查库的调用：Bearer 请求先本地验 JWT 签名，
 * 再经 isolate 缓存（lib/auth-cache.ts）把这里的调用频率压到
 * 每用户每 isolate 每 30 秒一次。
 */
export async function loadAuthedUser(
  env: Bindings,
  sessionId: string,
): Promise<SessionRecord | null> {
  if (!sessionId) return null;
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
    lastSeenAt: row.lastSeenAt,
  };
}

/** 滑动续期：最多每 15 分钟写一次 —— 没到节流点就跳过写入。 */
export async function renewSession(env: Bindings, sessionId: string, lastSeenAt: number): Promise<void> {
  const now = Date.now();
  if (now - lastSeenAt <= LIMITS.sessionRenewIntervalSeconds * 1000) return;
  await createDb(env.DB).update(sessions)
    .set({ lastSeenAt: now, expiresAt: now + LIMITS.sessionIdleSeconds * 1000 })
    .where(eq(sessions.id, sessionId));
}

/** 签发 web access token。密钥缺失是部署错误，直接失败而不是降级。 */
export async function mintWebToken(env: Pick<Bindings, 'SESSION_SECRET'>, userId: number, sessionId: string): Promise<string> {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET 未配置，无法签发访问令牌');
  return mintWebAccessToken(env.SESSION_SECRET, userId, sessionId, LIMITS.webAccessTokenSeconds);
}

/**
 * 整页导航（OAuth 登录、Connect authorize）不带 Authorization 头，
 * 发起链接以 web_token 查询参数携带当前身份；服务器验签后走常规会话校验。
 * 返回的 sessionId 可直接挂回 context，供下游会话新鲜度检查使用。
 */
export async function actorFromWebToken(
  env: Bindings,
  token: string | undefined,
): Promise<{ user: AuthedUser; sessionId: string } | null> {
  if (!token || !env.SESSION_SECRET) return null;
  const claims = await verifyWebAccessToken(env.SESSION_SECRET, token);
  if (!claims) return null;
  const record = await loadAuthedUser(env, claims.sid);
  return record ? { user: record.user, sessionId: record.sessionId } : null;
}

export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  /** access token 有效期（秒），前端据此安排主动刷新 */
  expiresIn: number;
  user: AuthedUser;
}

/** 会话行已存在时组装令牌响应（登录完成与刷新共用） */
export async function grantTokensForSession(
  env: Bindings,
  sessionId: string,
  refreshToken: string,
): Promise<TokenGrant> {
  const record = await loadAuthedUser(env, sessionId);
  if (!record) throw new Error('刚创建的会话无法读取，检查数据库一致性');
  const accessToken = await mintWebToken(env, record.user.id, sessionId);
  return { accessToken, refreshToken, expiresIn: LIMITS.webAccessTokenSeconds, user: record.user };
}

/**
 * 创建会话并签发一对令牌。
 * 登录时**必须新建**会话而不是复用已有的 —— 这是防会话固定攻击。
 */
export async function issueTokensFor(
  env: Bindings,
  userId: number,
  meta: { ip?: string | null; userAgent?: string | null; remember?: boolean },
): Promise<TokenGrant> {
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
  return grantTokensForSession(env, tokenHash, token);
}

export async function revokeSession(env: Bindings, sessionId: string): Promise<void> {
  const db = createDb(env.DB);
  await db.update(sessions).set({ revokedAt: Date.now() }).where(eq(sessions.id, sessionId));
  invalidateCachedSession(sessionId);
}

/** 撤销某用户的全部会话（改密、重置密码、封禁时用） */
export async function revokeAllSessions(
  env: { DB: Bindings['DB'] },
  userId: number,
): Promise<void> {
  const db = createDb(env.DB);
  await db.update(sessions).set({ revokedAt: Date.now() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  invalidateCachedSessionsOf(userId);
}

// ── 设置读取 ─────────────────────────────────────────────────────────────────
// 设置几乎每个请求都要读，因此在 isolate 内缓存 60 秒。
// 写入时递增版本号、缓存键包含版本，所以管理员改动会立即在所有 isolate 生效。

let settingsCache: { values: Record<string, string>; generation: number; expiresAt: number } | null = null;
// 冷缓存并发去重：同一 isolate 上多个调用方同时未命中时，只有首个真正查库，
// 其余等待同一份结果（避免冷启动风暴放大 D1 读取）。
let settingsInflight: Promise<Record<string, string>> | null = null;

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
  // 配置读缓存（configuration.ts）与设置同源：任何 settings 写入都要一并失效。
  // 代数计数器是零依赖模块，两处缓存同步读取它；递增后配置缓存条目因
  // 代数不匹配立即过期，不需要（也不能）静态导入 configuration.ts —— 会成环。
  bumpCacheGeneration();
}

export async function readSettings(env: Pick<Bindings, 'DB'>): Promise<Record<string, string>> {
  const now = Date.now();
  if (settingsCache && settingsCache.generation === currentCacheGeneration() && settingsCache.expiresAt > now) return settingsCache.values;
  if (settingsInflight) return settingsInflight;

  settingsInflight = (async () => {
    // 快照代数：查询飞行期间若发生失效，旧结果带着旧代数入缓存，
    // 下个请求会立即判过期重新查库，不会把旧设置当成新值缓存 60 秒。
    const generation = currentCacheGeneration();
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

    settingsCache = { values, generation, expiresAt: Date.now() + 60_000 };
    return values;
  })();
  try {
    return await settingsInflight;
  } finally {
    settingsInflight = null;
  }
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
