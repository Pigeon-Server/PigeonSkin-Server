// 人机验证的端点级强制回归：image 驱动（离线，无外网依赖）下端到端验证
// 登录"失败升级"与评论"每次强制"两条契约。
//
// 设计依据 docs/rewrite/05-authentication.md §4.2：
//   • 登录 —— 15 分钟内失败 3 次后要求人机验证（与旧版阈值一致）；
//     达阈值后空/无效凭据返回 403 auth.captcha_failed，
//     有效凭据但密码错误返回 401 并携带 captchaRequired 信号（供前端展示验证组件）。
//   • 评论 —— 每次提交都强制（fail-closed），空凭据 403、有效凭据 201。
/// <reference types="@cloudflare/vitest-pool-workers" />

import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, makeAdmin } from './setup.ts';
import { invalidateSettingsCache } from '../src/core/settings-reader.ts';
import { resolveConfiguration } from '../src/services/configuration.ts';
import type { Bindings } from '../src/core/env.ts';

const PASSWORD = 'repro-pass-9';

let adminCookie = '';
beforeAll(async () => {
  await runMigrations();
  adminCookie = await admin();
});
beforeEach(async () => {
  const keys = ['captcha_driver', 'captcha_site_key', 'captcha_secret'];
  await env.DB.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).run();
  invalidateSettingsCache();
});

async function admin(role = 'super_admin') {
  const email = `caprepro-${crypto.randomUUID()}@example.com`;
  const registered = await SELF.fetch('https://x/api/v1/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ email, password: PASSWORD, playerName: `cap${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}` }),
  });
  expect(registered.status).toBe(201);
  const { id } = await registered.json<{ id: number }>();
  await makeAdmin(id);
  if (role !== 'super_admin') await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  const logged = await SELF.fetch('https://x/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ identifier: email, password: PASSWORD }),
  });
  return (await logged.json<{ accessToken: string }>()).accessToken;
}
async function setSettings(cookie: string, entries: Record<string, string>) {
  return SELF.fetch('https://x/api/v1/admin/settings', {
    method: 'PATCH', headers: { authorization: `Bearer ${cookie}`, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ settings: Object.entries(entries).map(([key, value]) => ({ key, value })) }),
  });
}
async function registerUser(): Promise<{ id: number; email: string }> {
  const email = `capu-${crypto.randomUUID()}@example.com`;
  const res = await SELF.fetch('https://x/api/v1/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ email, password: PASSWORD, playerName: `capu${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}` }),
  });
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: number }>();
  return { id, email };
}
async function login(identifier: string, password = PASSWORD, captchaToken = '', captchaRandstr = ''): Promise<Response> {
  return SELF.fetch('https://x/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ identifier, password, captchaToken, captchaRandstr }),
  });
}
async function authedFetch(cookie: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${cookie}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('sec-fetch-site', 'same-origin');
  return SELF.fetch(url, { ...init, headers });
}
/** 直插一条公开、非官方、可评论的纹理行 */
async function seedTexture(uploaderId: number): Promise<number> {
  const now = Date.now();
  const r = await env.DB.prepare(
    "INSERT INTO textures(hash,kind,model,name,uploader_id,size_bytes,visibility,width,height,official_key,origin,created_at,updated_at) VALUES(?, 'skin','default','repro-tex',?,8192,'public',64,64,NULL,'repost',?,?)",
  ).bind('c'.repeat(64), uploaderId, now, now).run();
  return r.meta.last_row_id as number;
}
async function seedLoginFailures(identifier: string, n: number): Promise<void> {
  const now = Date.now();
  await env.DB.batch(Array.from({ length: n }, () =>
    env.DB.prepare("INSERT INTO auth_attempts(ip,identifier,kind,succeeded,created_at) VALUES(?,?, 'login',0,?)").bind('1.1.1.1', identifier, now)));
}
/** 开启 image 驱动并确认服务端解析后的绑定确实启用 */
async function enableImageCaptcha(): Promise<void> {
  const patch = await setSettings(adminCookie, { captcha_driver: 'image' });
  expect(patch.status).toBe(200);
  const bindings = await resolveConfiguration(env as Bindings);
  expect(bindings.CAPTCHA_DRIVER).toBe('image');
}
/** 从出题端点拿一道题，答案即题面 SVG 的 <text> 字符（image 驱动答案画在 SVG 里） */
async function solveImageChallenge(): Promise<{ token: string; randstr: string }> {
  const res = await SELF.fetch('https://x/api/v1/auth/captcha/challenge');
  expect(res.status).toBe(200);
  const { challengeId, svg } = await res.json<{ challengeId: string; svg: string }>();
  const chars = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]!);
  return { token: challengeId, randstr: chars.join('') };
}
async function loggedInCookie(email: string): Promise<string> {
  const res = await login(email);
  expect(res.status).toBe(200);
  return (await res.json<{ accessToken: string }>()).accessToken;
}

describe('login captcha escalation (image driver)', () => {
  it('passes a correct password without a token while under the failure threshold', async () => {
    const u = await registerUser();
    await enableImageCaptcha();
    expect((await login(u.email)).status).toBe(200);
  });

  it('rejects a tokenless login at the failure threshold with captcha_failed', async () => {
    const u = await registerUser();
    await enableImageCaptcha();
    await seedLoginFailures(u.email, 3);
    const res = await login(u.email); // 密码正确，但已达阈值且不带验证码
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe('auth.captcha_failed');
  });

  it('signals captchaRequired on a 401 after a valid captcha is consumed', async () => {
    const u = await registerUser();
    await enableImageCaptcha();
    await seedLoginFailures(u.email, 3);
    const { token, randstr } = await solveImageChallenge();
    const res = await login(u.email, 'wrong-password-9', token, randstr); // 有效验证码 + 错误密码
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string; captchaRequired?: boolean }>();
    expect(body.error).toBe('auth.invalid_credentials');
    expect(body.captchaRequired).toBe(true);
  });

  it('accepts the token at the threshold with the correct password', async () => {
    const u = await registerUser();
    await enableImageCaptcha();
    await seedLoginFailures(u.email, 3);
    const { token, randstr } = await solveImageChallenge();
    expect((await login(u.email, PASSWORD, token, randstr)).status).toBe(200);
  });
});

describe('comment captcha enforcement (image driver)', () => {
  it('rejects a comment without a token', async () => {
    const u = await registerUser();
    const texId = await seedTexture(u.id);
    const cookie = await loggedInCookie(u.email);
    await enableImageCaptcha();
    const res = await authedFetch(cookie, `https://x/api/v1/textures/${texId}/comments`, {
      method: 'POST', body: JSON.stringify({ content: 'no-captcha-comment' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe('auth.captcha_failed');
  });

  it('accepts a comment with a solved token', async () => {
    const u = await registerUser();
    const texId = await seedTexture(u.id);
    const cookie = await loggedInCookie(u.email);
    await enableImageCaptcha();
    const { token, randstr } = await solveImageChallenge();
    const res = await authedFetch(cookie, `https://x/api/v1/textures/${texId}/comments`, {
      method: 'POST', body: JSON.stringify({ content: 'with-captcha-comment', captchaToken: token, captchaRandstr: randstr }),
    });
    expect(res.status).toBe(201);
  });
});
