// 一次性令牌：邮箱验证与密码重置。
//
// 旧版这两条链路都用 **HMAC 签名 URL**，不落库：
//   • 邮箱验证链接**永久有效且可重复使用**（签名没有过期时间）
//   • 密码重置链接在 1 小时窗口内**可重复使用**
//
// 新设计改成落库的一次性令牌，两个问题一起解决：可过期、可用一次、可撤销。
// 原始令牌只出现在邮件链接里，库里存的是它的 SHA-256 —— 库被读走也拿不到可用令牌。
import {
  createDb, passwordResetTokens, users, verificationTokens,
} from '@pigeon-skin/db';
import { mintTokenWithHash, hashToken } from '@pigeon-skin/auth';
import { and, eq, isNull } from 'drizzle-orm';
import { fail } from '../framework.ts';
import type { Bindings } from '../env.ts';

export interface TokenEnv {
  DB: Bindings['DB'];
}

function db(env: TokenEnv) {
  return createDb(env.DB);
}

// ── 邮箱验证 ─────────────────────────────────────────────────────────────────

export async function issueVerificationToken(
  env: TokenEnv,
  userId: number,
  email: string,
  ttlSeconds: number,
): Promise<string> {
  const { token, tokenHash } = await mintTokenWithHash();
  const now = Date.now();

  await db(env).insert(verificationTokens)
    .values({ id: tokenHash, userId, email, createdAt: now, expiresAt: now + ttlSeconds * 1000 });

  return token;
}

/**
 * 消费验证令牌。
 *
 * 同时校验邮箱未变：如果用户在发出令牌之后改了邮箱，旧令牌应当失效，
 * 否则可以拿它去验证一个已经不属于自己的地址。
 */
export async function consumeVerificationToken(
  env: TokenEnv,
  rawToken: string,
): Promise<{ userId: number }> {
  const id = await hashToken(rawToken);
  const database = db(env);

  const [row] = await database
    .select({
      userId: verificationTokens.userId,
      email: verificationTokens.email,
      expiresAt: verificationTokens.expiresAt,
      consumedAt: verificationTokens.consumedAt,
    })
    .from(verificationTokens)
    .where(eq(verificationTokens.id, id))
    .limit(1);

  if (!row) throw fail.notFound('auth.invalid_token');
  if (row.consumedAt !== null) throw fail.conflict('auth.token_consumed');
  if (row.expiresAt <= Date.now()) throw fail.conflict('auth.token_expired');

  const [user] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user || user.email.toLowerCase() !== row.email.toLowerCase()) {
    throw fail.conflict('auth.invalid_token');
  }

  await database.update(verificationTokens)
    .set({ consumedAt: Date.now() })
    .where(eq(verificationTokens.id, id));
  await database.update(users)
    .set({ emailVerifiedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(users.id, row.userId));

  return { userId: row.userId };
}

// ── 密码重置 ─────────────────────────────────────────────────────────────────

export async function issuePasswordResetToken(
  env: TokenEnv,
  userId: number,
  ttlSeconds: number,
): Promise<string> {
  const { token, tokenHash } = await mintTokenWithHash();
  const now = Date.now();

  await db(env).insert(passwordResetTokens)
    .values({ id: tokenHash, userId, createdAt: now, expiresAt: now + ttlSeconds * 1000 });

  return token;
}

export async function consumePasswordResetToken(
  env: TokenEnv,
  rawToken: string,
): Promise<{ userId: number }> {
  const id = await hashToken(rawToken);
  const database = db(env);

  const [row] = await database
    .select({
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      consumedAt: passwordResetTokens.consumedAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.id, id))
    .limit(1);

  if (!row) throw fail.notFound('auth.invalid_token');
  if (row.consumedAt !== null) throw fail.conflict('auth.token_consumed');
  if (row.expiresAt <= Date.now()) throw fail.conflict('auth.token_expired');

  await database.update(passwordResetTokens)
    .set({ consumedAt: Date.now() })
    .where(eq(passwordResetTokens.id, id));

  return { userId: row.userId };
}

/** 撤销某用户所有未使用的令牌。改邮箱或改密码时调用。 */
export async function revokePendingTokens(env: TokenEnv, userId: number): Promise<void> {
  const now = Date.now();
  const database = db(env);
  await database.update(verificationTokens).set({ consumedAt: now })
    .where(and(eq(verificationTokens.userId, userId), isNull(verificationTokens.consumedAt)));
  await database.update(passwordResetTokens).set({ consumedAt: now })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.consumedAt)));
}

/** 清理过期令牌。由每日定时任务调用。 */
export async function pruneExpiredTokens(env: TokenEnv): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('DELETE FROM verification_tokens WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?').bind(now).run();
}
