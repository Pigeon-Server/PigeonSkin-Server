// 认证路由。
//
// 注册与登录的业务规则在 services/auth.ts，会话的创建与撤销在 lib.ts。
import { Hono } from 'hono';
import {
  forgotPasswordInputSchema, loginInputSchema, registerInputSchema,
  resetPasswordInputSchema, verifyEmailInputSchema,
} from '@pigeon-skin/shared/schemas';
import { LIMITS, type PlayerNameRule } from '@pigeon-skin/shared';
import { normalizeLocale } from '@pigeon-skin/shared/locales';
import { hashPassword, hashToken } from '@pigeon-skin/auth';
import { createDb } from '@pigeon-skin/db';
import { AppError, currentUser, fail, readJson } from '../framework.ts';
import * as auth from '../services/auth.ts';
import * as tokens from '../services/tokens.ts';
import * as repo from '../repositories/auth.ts';
import { initializationSchema, initializationStatus, initializeAccount } from '../services/account-initialization.ts';
import { isEmailConfigured, sendEmail } from '../services/email.ts';
import * as security from '../services/security.ts';
import * as securityRepo from '../repositories/security.ts';
import { turnstileAllows, verifyTurnstile, isTurnstileEnabled } from '../services/turnstile.ts';
import {
  clearSessionCookie, clientIp, createSession, getSetting, getSettingBool, getSettingInt,
  revokeAllSessions, revokeSession, setSessionCookie, type AppEnv, type AuthedUser,
} from '../lib.ts';

export const authRoutes = new Hono<AppEnv>();

/** 注册相关的设置项。集中一处读，避免路由里散落一堆 getSetting。 */
async function readRegistrationSettings(env: AppEnv['Bindings']): Promise<auth.RegistrationSettings> {
  return {
    enabled: await getSettingBool(env, 'registration_enabled'),
    withPlayerName: await getSettingBool(env, 'register_with_player_name'),
    playerNameRule: (await getSetting(env, 'player_name_rule')) as PlayerNameRule,
    playerNameRegexp: await getSetting(env, 'player_name_regexp'),
    playerNameMin: await getSettingInt(env, 'player_name_length_min'),
    playerNameMax: await getSettingInt(env, 'player_name_length_max'),
    regsPerIp: await getSettingInt(env, 'regs_per_ip'),
    initialScore: await getSettingInt(env, 'initial_score'),
  };
}

/** 对外暴露的用户字段。密码哈希等敏感列绝不在这里出现。 */
function toPublicUser(user: AuthedUser): Record<string, unknown> {
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
  };
}

// ── 注册 ─────────────────────────────────────────────────────────────────────

authRoutes.post('/register', async (c) => {
  const body = await readJson(c, registerInputSchema);
  const ip = clientIp(c);

  // 注册易被滥用，验证码不可用或校验失败时**关闭**
  const verdict = await verifyTurnstile(c.env, body.turnstileToken, ip);
  if (!turnstileAllows(verdict, false)) throw fail.forbidden('auth.captcha_failed');

  const { userId } = await auth.register(c.env, body, await readRegistrationSettings(c.env), ip);

  // 注册成功即自动登录（与旧版行为一致）
  const { token, maxAgeSeconds } = await createSession(c.env, userId, {
    ip,
    userAgent: c.req.header('user-agent') ?? null,
  });
  setSessionCookie(c, token, maxAgeSeconds);

  // 站点开启了"必须验证邮箱"时，注册成功就顺手把验证信发出去。
  // 失败不回滚注册 —— 用户可以随时从设置页重新请求（该端点有节流）。
  if (await getSettingBool(c.env, 'require_email_verification') && isEmailConfigured(c.env)) {
    const email = body.email;
    c.executionCtx.waitUntil((async () => {
      try {
        const token = await tokens.issueVerificationToken(
          c.env, userId, email, LIMITS.verificationTokenSeconds,
        );
        const result = await sendEmail(c.env, {
          kind: 'verify-email', to: email, token, locale: normalizeLocale(c.req.header('x-locale') || 'en'),
        });
        if (result.ok) await recordMailSent(c.env.DB, email);
      } catch { /* 交由用户手动重发 */ }
    })());
  }

  return c.json({ id: userId }, 201);
});

// ── 登录 ─────────────────────────────────────────────────────────────────────

authRoutes.post('/login', async (c) => {
  const body = await readJson(c, loginInputSchema);
  const ip = clientIp(c);

  // 失败次数达到阈值后强制要求验证码（按 identifier 计数，不按 IP ——
  // NAT 后的正常用户不该被连坐）。验证码服务不可用时 fail-open：
  // 把全体用户锁在门外比失去升级更糟。
  const failures = await repo.countRecentFailures(
    c.env.DB, body.identifier, LIMITS.loginFailureWindowSeconds * 1000,
  );
  const captchaRequired = failures >= LIMITS.captchaAfterFailures;
  if (captchaRequired && isTurnstileEnabled(c.env)) {
    const verdict = await verifyTurnstile(c.env, body.turnstileToken, ip);
    if (!turnstileAllows(verdict, true)) throw fail.forbidden('auth.captcha_failed');
  }

  try {
    const user = await auth.login(c.env, body, {
      ip,
      requireEmailVerification: await getSettingBool(c.env, 'require_email_verification'),
    });

    c.header('Cache-Control', 'no-store');
    const payload = { remember: body.keep === true, destination: security.destination(body.destination) };
    if (user.pendingMerge) {
      const snapshots = [];
      const ids: number[] = [];
      for (const id of user.pendingMerge.ids) {
        snapshots.push({ id, hash: await security.credentialsHash(c.env, id), version: (await securityRepo.state(c.env, id)).version });
        if ((await securityRepo.methods(c.env, id)).length) ids.push(id);
      }
      await security.newChallenge(c, ids[0]!, 'login', { ...payload, merge: { retainedId: user.id, ids, snapshots, verifiedIds: [] } });
      return c.json({ requiresTwoFactor: true, methods: await securityRepo.methods(c.env, ids[0]!) });
    }
    if (await security.beginLogin(c, user.id, payload)) return c.json({ requiresTwoFactor: true, methods: await securityRepo.methods(c.env, user.id) });

    // 会话轮换：登录成功后撤销该用户此前的一切会话。旧会话要么属于
    // 同一个人的旧设备（换设备登录踢下线，与旧版"登录即挤掉旧会话"的
    // 体验一致），要么属于偷到 Cookie 的攻击者 —— 两种情况都该失效。
    await revokeAllSessions(c.env, user.id);

    const { token, maxAgeSeconds } = await createSession(c.env, user.id, {
      ip,
      userAgent: c.req.header('user-agent') ?? null,
      remember: body.keep === true,
    });
    setSessionCookie(c, token, maxAgeSeconds);

    return c.json({ id: user.id });
  } catch (e) {
    if (e instanceof auth.EmailConflictError) return c.json({ error: e.code, accounts: e.accounts, requiresPasswords: e.requiresPasswords }, 409);
    // 告诉前端：下一次尝试需要带验证码。只在**确实已达到阈值**时暴露 ——
    // 未达阈值的登录响应不含该字段，否则首次失败就诱导用户去解验证码。
    if (e instanceof AppError && e.status === 401 && captchaRequired) {
      return c.json({ error: 'auth.invalid_credentials', captchaRequired: true }, 401);
    }
    throw e;
  }
});

// ── 登出 ─────────────────────────────────────────────────────────────────────

authRoutes.post('/logout', async (c) => {
  const sessionId = c.get('sessionId');
  if (sessionId) await revokeSession(c.env, sessionId);
  security.clearChallenge(c);
  clearSessionCookie(c);
  return c.body(null, 204);
});

// ── 当前会话 ─────────────────────────────────────────────────────────────────

authRoutes.get('/session', async (c) => {
  const user = currentUser(c);
  return c.json(toPublicUser(user));
});
authRoutes.get('/initialize', async c => {
  const user = currentUser(c), status = await initializationStatus(c.env, user.id);
  const ticket = status.needsInitialization ? crypto.randomUUID() : '';
  c.header('Cache-Control', 'no-store');
  if (ticket) await c.env.DB.prepare('INSERT INTO oauth_login_states (id, provider, browser_hash, user_id, session_id, verifier, destination, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(await hashToken(ticket), 'initialize', '', user.id, c.get('sessionId'), '', '', Date.now() + 1800000).run();
  return c.json({ ...status, ticket });
});
authRoutes.post('/initialize', async c => {
  c.header('Cache-Control', 'no-store');
  const user = currentUser(c);
  const body = await readJson(c, initializationSchema);
  if ((await securityRepo.methods(c.env, user.id)).length) await security.assertReauth(c);
  const sessionId = c.get('sessionId');
  if (!sessionId) throw fail.unauthorized();
  const result = await initializeAccount(c.env, user.id, sessionId, body);
  await revokeAllSessions(c.env, user.id);
  const { token, maxAgeSeconds } = await createSession(c.env, user.id, { ip: clientIp(c), userAgent: c.req.header('user-agent') ?? null });
  setSessionCookie(c, token, maxAgeSeconds);
  return c.json(result);
});

// ── 邮箱验证 ─────────────────────────────────────────────────────────────────

/**
 * 邮件发送节流：同一标识在窗口内只允许发一封。
 *
 * Resend 免费层每天 100 封，一个可以无限刷验证信的端点能把整站的
 * 邮件预算烧光。复用 auth_attempts 表做计数（kind='mail'），不引入新表。
 */
async function assertMailThrottle(
  d1: AppEnv['Bindings']['DB'],
  identifier: string,
  windowSeconds: number,
): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const result = await d1
    .prepare(
      `SELECT COUNT(*) AS n FROM auth_attempts
       WHERE kind = 'mail' AND identifier = ? AND created_at > ?`,
    )
    .bind(identifier, Date.now() - windowMs)
    .first<{ n: number }>();
  if ((result?.n ?? 0) > 0) {
    throw new AppError('common.rate_limited', 429);
  }
}

function recordMailSent(
  d1: AppEnv['Bindings']['DB'],
  identifier: string,
): Promise<unknown> {
  return d1
    .prepare(
      `INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at)
       VALUES (?, ?, 'mail', 1, ?)`,
    )
    .bind('', identifier, Date.now())
    .run();
}

authRoutes.post('/verify-email/request', async (c) => {
  const user = currentUser(c);
  if (user.emailVerifiedAt !== null) return c.json({ ok: true, alreadyVerified: true });

  // 节流先于"邮件未配置"判定：服务端配置缺失不是绕过限流的通道
  await assertMailThrottle(c.env.DB, user.email, LIMITS.emailSendIntervalSeconds);

  // 邮件未配置时明确报错，而不是静默"发送成功"
  if (!isEmailConfigured(c.env)) throw new AppError('auth.mail_unavailable', 503);

  const token = await tokens.issueVerificationToken(
    c.env, user.id, user.email, LIMITS.verificationTokenSeconds,
  );
  const result = await sendEmail(c.env, {
    kind: 'verify-email', to: user.email, token, locale: user.locale,
  });

  // 只有真的把邮件交给了服务商才计数；服务故障时不挡用户重试
  if (result.ok) await recordMailSent(c.env.DB, user.email);

  return c.json({ ok: result.ok, reason: result.reason });
});

authRoutes.post('/verify-email/confirm', async (c) => {
  const body = await readJson(c, verifyEmailInputSchema);
  await tokens.consumeVerificationToken(c.env, body.token);
  return c.json({ ok: true });
});

// ── 密码找回 ─────────────────────────────────────────────────────────────────

authRoutes.post('/forgot-password', async (c) => {
  const body = await readJson(c, forgotPasswordInputSchema);
  const ip = clientIp(c);

  // 找回密码易被滥用，验证码失败时**关闭**（正常用户几秒后重试即可）
  const verdict = await verifyTurnstile(c.env, body.turnstileToken, ip);
  if (!turnstileAllows(verdict, false)) throw fail.forbidden('auth.captcha_failed');

  if (!isEmailConfigured(c.env)) throw new AppError('auth.mail_unavailable', 503);

  // 无论账号是否存在都返回同样的响应，避免邮箱枚举
  const generic = { ok: true } as const;

  // 按 IP 节流在枚举防护返回之前执行 —— 枚举防护不能被用来绕过限流刷邮件
  await assertMailThrottle(c.env.DB, `reset:${ip}`, LIMITS.passwordResetIntervalSeconds);

  const database = createDb(c.env.DB);
  const user = await repo.findUserByEmail(database, body.email);
  if (!user) return c.json(generic);

  const token = await tokens.issuePasswordResetToken(
    c.env, user.id, LIMITS.passwordResetTokenSeconds,
  );
  const mail = await sendEmail(c.env, { kind: 'password-reset', to: user.email, token, locale: normalizeLocale(c.req.header('x-locale') || 'en') });

  // 同一 IP 对任意邮箱的重置请求共用一个节流桶（identifier 是 IP 不是邮箱，
  // 否则攻击者可对每个邮箱各刷一封）
  if (mail.ok) await recordMailSent(c.env.DB, `reset:${ip}`);

  return c.json(generic);
});

authRoutes.post('/reset-password', async (c) => {
  const body = await readJson(c, resetPasswordInputSchema);
  const { userId } = await tokens.consumePasswordResetToken(c.env, body.token);

  const database = createDb(c.env.DB);
  await repo.updatePasswordHash(database, userId, await hashPassword(body.password));

  // 重置密码后撤销全部会话并作废其余待处理令牌
  await revokeAllSessions(c.env, userId);
  await tokens.revokePendingTokens(c.env, userId);

  return c.json({ ok: true });
});
