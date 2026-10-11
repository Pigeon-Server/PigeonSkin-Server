// 认证路由。
//
// 注册与登录的业务规则在 services/auth.ts，会话的创建与撤销在 lib.ts。
import { AppError, currentUser, fail, readJson } from '../../core/framework.ts';
import { clientIp } from '../../core/ip.ts';
import { clearSessionCookie, issueTokensFor, loadAuthedUser, mintWebToken, renewSession, revokeAllSessions, revokeSession } from '../../core/session.ts';
import { getSetting, getSettingBool, getSettingInt } from '../../core/settings-reader.ts';
import { toPublicUser, type AppEnv, type AuthedUser } from '../../core/user.ts';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  forgotPasswordInputSchema, loginInputSchema, registerInputSchema,
  resetPasswordInputSchema, verifyEmailInputSchema,
} from './../../core/schemas.ts';
import { LIMITS, type PlayerNameRule } from '@pigeon-skin/shared';
import { normalizeLocale } from '@pigeon-skin/shared/locales';
import { hashPassword, hashToken } from '@pigeon-skin/auth';
import { createDb } from '@pigeon-skin/db';

import * as auth from '../../services/auth.ts';
import * as tokens from '../../services/tokens.ts';
import * as repo from '../../repositories/auth.ts';
import { initializationSchema, initializationStatus, initializeAccount } from '../../services/account-initialization.ts';
import { isEmailConfigured, sendEmail } from '../../services/email.ts';
import * as security from '../../services/security.ts';
import * as securityRepo from '../../repositories/security.ts';
import { captchaAllows, verifyCaptcha, isCaptchaEnabled, captchaDriver } from '../../services/captcha.ts';
import { issueImageCaptcha } from '../../services/image-captcha.ts';

export const authRoutes = new Hono<AppEnv>();

/** 登录成功响应的形状：LoginResult 的非 2FA 分支 + 令牌对。 */
function tokenPayload(grant: { accessToken: string; refreshToken: string; expiresIn: number; user: AuthedUser }) {
  return {
    id: grant.user.id,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresIn: grant.expiresIn,
    user: toPublicUser(grant.user),
  };
}

// 自绘图案验证码出题：driver 为 image 时前端拉取新题。
// 未登录可访问（登录/注册页都要用）；driver 不是 image 时返回空题面，
// 前端凭 captcha_site_key 为空同样不会渲染组件，这里只为显式一致。
authRoutes.get('/captcha/challenge', async (c) => {
  if (captchaDriver(c.env) !== 'image') return c.json({ challengeId: '', svg: '', ttlSeconds: 0 });
  return c.json(await issueImageCaptcha(c.env));
});

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

// 对外暴露的用户字段序列化统一在 lib.ts 的 toPublicUser。

// ── 注册 ─────────────────────────────────────────────────────────────────────

authRoutes.post('/register', async (c) => {
  const body = await readJson(c, registerInputSchema);
  const ip = clientIp(c);

  // 注册易被滥用，验证码不可用或校验失败时**关闭**
  const verdict = await verifyCaptcha(c.env, { token: body.captchaToken, randstr: body.captchaRandstr }, ip);
  if (!captchaAllows(verdict, false)) throw fail.forbidden('auth.captcha_failed');

  const { userId } = await auth.register(c.env, body, await readRegistrationSettings(c.env), ip);

  // 注册成功即自动登录（与旧版行为一致），令牌随响应交给前端保存
  const grant = await issueTokensFor(c.env, userId, {
    ip,
    userAgent: c.req.header('user-agent') ?? null,
  });

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

  return c.json(tokenPayload(grant), 201);
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
  if (captchaRequired && isCaptchaEnabled(c.env)) {
    const verdict = await verifyCaptcha(c.env, { token: body.captchaToken, randstr: body.captchaRandstr }, ip);
    if (!captchaAllows(verdict, true)) throw fail.forbidden('auth.captcha_failed');
  }

  try {
    const user = await auth.login(c.env, body, { ip });

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
    // 体验一致），要么属于偷到令牌的攻击者 —— 两种情况都该失效。
    await revokeAllSessions(c.env, user.id);

    const grant = await issueTokensFor(c.env, user.id, {
      ip,
      userAgent: c.req.header('user-agent') ?? null,
      remember: body.keep === true,
    });

    return c.json(tokenPayload(grant));
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
  // 一次性切换前签发的存量会话 Cookie 不再被读取，登出时顺手清掉
  clearSessionCookie(c);
  return c.body(null, 204);
});

// ── 令牌刷新 ─────────────────────────────────────────────────────────────────

/**
 * 用 refresh 令牌换新的 access token。
 *
 * refresh 令牌就是 sessions 表里的不透明会话令牌：直接查库校验（刷新是低频
 * 操作，不走缓存），通过后沿用滑动续期节流。不轮换 refresh 令牌 —— 与旧
 * cookie 会话的暴露面一致，还让多标签页并发刷新天然安全。
 */
authRoutes.post('/refresh', async (c) => {
  c.header('Cache-Control', 'no-store');
  const body = await readJson(c, z.object({ refreshToken: z.string().min(20).max(128) }));
  const sessionId = await hashToken(body.refreshToken);
  const record = await loadAuthedUser(c.env, sessionId);
  if (!record) throw fail.unauthorized();
  await renewSession(c.env, sessionId, record.lastSeenAt);
  const accessToken = await mintWebToken(c.env, record.user.id, sessionId);
  return c.json({
    accessToken,
    refreshToken: body.refreshToken,
    expiresIn: LIMITS.webAccessTokenSeconds,
    user: toPublicUser(record.user),
  });
});

// ── 一次性 code 换令牌（OAuth 社交登录回调用）───────────────────────────────

/**
 * 服务端在 OAuth 提供商回调处签发一次性 code，前端路由换成令牌对。
 * code 复用 oauth_login_states 表（provider='web-exchange'，消费即删），
 * 单次有效、5 分钟过期；换发时才真正建会话，撤销窗口最小。
 */
authRoutes.post('/token', async (c) => {
  c.header('Cache-Control', 'no-store');
  const body = await readJson(c, z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }));
  const row = await c.env.DB.prepare("DELETE FROM oauth_login_states WHERE id = ? AND provider = 'web-exchange' AND expires_at > ? RETURNING user_id, destination")
    .bind(await hashToken(body.code), Date.now())
    .first<{ user_id: number; destination: string }>();
  if (!row) throw fail.unauthorized();
  const grant = await issueTokensFor(c.env, row.user_id, {
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
  });
  return c.json({ ...tokenPayload(grant), destination: security.destination(row.destination) });
});

// ── 当前会话 ─────────────────────────────────────────────────────────────────

authRoutes.get('/session', async (c) => {
  // 会话端点是前端显式的状态刷新入口（登录态变化后强制拉取最新资料），
  // 绕过 isolate 缓存直接读库 —— 与旧 cookie 会话的每请求读行为对齐。
  const sessionId = c.get('sessionId');
  const record = sessionId ? await loadAuthedUser(c.env, sessionId) : null;
  if (record) await renewSession(c.env, record.sessionId, record.lastSeenAt);
  return c.json(toPublicUser(record?.user ?? currentUser(c)));
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
  const grant = await issueTokensFor(c.env, user.id, { ip: clientIp(c), userAgent: c.req.header('user-agent') ?? null });
  return c.json({ ...result, ...tokenPayload(grant) });
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
  const verdict = await verifyCaptcha(c.env, { token: body.captchaToken, randstr: body.captchaRandstr }, ip);
  if (!captchaAllows(verdict, false)) throw fail.forbidden('auth.captcha_failed');

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
