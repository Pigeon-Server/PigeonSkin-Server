// 当前用户自己的接口。
import { Hono } from 'hono';
import { z } from 'zod';
import { isLocale } from '@pigeon-skin/shared/i18n';
import {
  changePasswordInputSchema, setAvatarInputSchema, updateProfileInputSchema,
} from '@pigeon-skin/shared/schemas';
import { currentUser, readJson, fail } from '../framework.ts';
import * as users from '../services/users.ts';
import * as notifications from '../services/notifications.ts';
import { isEmailConfigured, sendEmail } from '../services/email.ts';
import { getSetting, getSettingInt, type AppEnv, type AuthedUser } from '../lib.ts';

export const meRoutes = new Hono<AppEnv>();

/** 计费与签到参数。集中一处读。 */
async function readScoreSettings(env: AppEnv['Bindings']): Promise<users.ScoreSettings> {
  return {
    initialScore: await getSettingInt(env, 'initial_score'),
    signRewardMin: await getSettingInt(env, 'sign_score_min'),
    signRewardMax: await getSettingInt(env, 'sign_score_max'),
    signGapHours: await getSettingInt(env, 'sign_gap_hours'),
    perKbPublic: await getSettingInt(env, 'score_per_kb_public'),
    perKbPrivate: await getSettingInt(env, 'score_per_kb_private'),
    perPlayer: await getSettingInt(env, 'score_per_player'),
    perClosetItem: await getSettingInt(env, 'score_per_closet_item'),
  };
}

function publicUser(user: AuthedUser): Record<string, unknown> {
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
    signature: user.signature,
    needsInitialization: user.needsInitialization,
  };
}

// ── 资料 ─────────────────────────────────────────────────────────────────────

meRoutes.get('/', async (c) => c.json(publicUser(currentUser(c))));
meRoutes.patch('/preferences', async c => {
  const user = currentUser(c);
  const body = await readJson(c, z.object({ locale: z.string().refine(isLocale).optional(), isDarkMode: z.boolean().optional() }).strict());
  await users.updateProfile(c.env, user.id, body);
  return c.json({ ok: true });
});

meRoutes.patch('/', async (c) => {
  const user = currentUser(c);
  const body = await readJson(c, updateProfileInputSchema);
  if (body.email !== undefined && body.email.toLowerCase() !== user.email.toLowerCase()) throw fail.forbidden('security.email_change_required');

  const result = await users.updateProfile(c.env, user.id, body);

  // 改邮箱后通知新旧两个地址 —— 账号被接管时用户才有机会察觉。
  // 邮件发送失败不影响资料已改的事实，所以不阻塞响应。
  if (result.emailChanged && result.oldEmail && isEmailConfigured(c.env)) {
    const payload = {
      kind: 'email-changed' as const,
      nickname: body.nickname ?? user.nickname,
      oldEmail: result.oldEmail,
      newEmail: body.email ?? '',
      locale: user.locale,
    };
    c.executionCtx.waitUntil(sendEmail(c.env, { ...payload, to: result.oldEmail }));
    c.executionCtx.waitUntil(sendEmail(c.env, { ...payload, to: body.email ?? '' }));
  }

  return c.json({ ok: true, emailChanged: result.emailChanged });
});

// ── 改密码 ───────────────────────────────────────────────────────────────────

meRoutes.post('/password', async (c) => {
  const user = currentUser(c);
  const body = await readJson(c, changePasswordInputSchema);
  const sessionId = c.get('sessionId');
  if (!sessionId) throw new Error('会话缺失');

  await users.changePassword(c.env, user.id, sessionId, body);

  if (isEmailConfigured(c.env)) {
    c.executionCtx.waitUntil(sendEmail(c.env, {
      kind: 'password-changed',
      to: user.email,
      nickname: user.nickname,
      locale: user.locale,
    }));
  }

  return c.json({ ok: true });
});

// ── 头像 ─────────────────────────────────────────────────────────────────────

meRoutes.post('/avatar', async (c) => {
  const user = currentUser(c);
  const body = await readJson(c, setAvatarInputSchema);
  // 0 与 null 都表示清除头像
  await users.setAvatar(c.env, user, body.textureId === 0 ? null : body.textureId);
  return c.json({ ok: true });
});

// ── 积分与签到 ───────────────────────────────────────────────────────────────

meRoutes.get('/score', async (c) => {
  const user = currentUser(c);
  return c.json(await users.readScoreInfo(c.env, user.id, await readScoreSettings(c.env), await getSetting(c.env, 'sign_reset_mode')));
});

meRoutes.post('/sign-in', async (c) => {
  const user = currentUser(c);
  return c.json(await users.signIn(c.env, user.id, {
    ...await readScoreSettings(c.env),
  }, await getSetting(c.env, 'sign_reset_mode')));
});

// ── 通知（挂在 /me 下，与旧版 /user 前缀的语义一致）─────────────────────────

meRoutes.get('/notifications', async (c) => {
  const user = currentUser(c);
  return c.json(await notifications.list(c.env, user.id, {
    unreadOnly: c.req.query('unread') === 'true',
  }));
});

// ── 注销账号 ─────────────────────────────────────────────────────────────────

meRoutes.delete('/', async (c) => {
  const user = currentUser(c);
  if (user.role === 'admin' || user.role === 'super_admin') throw fail.forbidden('admin.forbidden');
  await users.deleteAccount(c.env, user.id);
  return c.body(null, 204);
});
