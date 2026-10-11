// 会话与令牌：双令牌模型（access JWT + refresh 不透明令牌）与 D1 sessions 行。
//
// Web 前端认证是双令牌：
//   • access token —— 短时效 JWT（HS256 / SESSION_SECRET），前端存 localStorage，
//     每请求经 Authorization 头本地验签，不查库；
//   • refresh token —— 不透明随机令牌，SHA-256 存 D1 sessions 表（沿用旧表），
//     前端凭它换新 access token。
// 撤销/封禁/改密等会话语义全部落在 sessions 行上，与旧 cookie 方案一致。
//
// 旧方案遗留的 Cookie 名称仅保留给登出清理存量 `__Host-bs_session` 用，
// 服务端不再读写它。
import { invalidateCachedSession, invalidateCachedSessionsOf } from './auth-cache.ts';
import { type Bindings } from './env.ts';
import { deleteCookie } from 'hono/cookie';
import { mintTokenWithHash, mintWebAccessToken, verifyWebAccessToken } from '@pigeon-skin/auth';
import { LIMITS, type Role } from '@pigeon-skin/shared';
import { createDb, users, sessions } from '@pigeon-skin/db';
import { and, eq, isNull, gt } from 'drizzle-orm';

import type { AppContext, AuthedUser } from './user.ts';
import { needsAccountInitialization } from './user.ts';

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
 * 再经 isolate 缓存（core/auth-cache.ts）把这里的调用频率压到
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
