// Web Bearer 认证的专项集成测试：撤销门禁、code 单次消费、web_token 伪造兜底。
//
// 登录/令牌生命周期在 api.test.ts，OAuth web-exchange 全流程在 oauth-social.test.ts，
// 这里只补改造后新增语义里没有被其他文件覆盖的分支。
import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { hashPassword } from '@pigeon-skin/auth';
import { runMigrations } from './setup.ts';
import { AUTH_BODY_PREFIXES, isAuthBodyPath } from '../src/route-metadata.ts';

const PASSWORD = 'bearer-check-pass-9';
let uid = 0, cookie = '', refreshToken = '';

async function json(path: string, body?: unknown, method = 'GET', session = cookie) {
  return SELF.fetch(`https://x${path}`, {
    method,
    headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  await runMigrations();
  const now = Date.now();
  const row = await env.DB.prepare("INSERT INTO users (email, nickname, password_hash, role, score, email_verified_at, created_at, updated_at) VALUES ('bearer-check@example.com', 'Bearer check', ?, 'normal', 1000, ?, ?, ?) RETURNING id")
    .bind(await hashPassword(PASSWORD), now, now, now).first<{ id: number }>();
  uid = row!.id;
  const login = await json('/api/v1/auth/login', { identifier: 'bearer-check@example.com', password: PASSWORD }, 'POST', '');
  const grant = await login.json<{ accessToken: string; refreshToken: string }>();
  cookie = grant.accessToken;
  refreshToken = grant.refreshToken;
});

describe('web bearer 门禁', () => {
  it('封禁用户普通路径 403，白名单路径（session/logout）仍可用', async () => {
    await env.DB.prepare("UPDATE users SET role = 'banned' WHERE id = ?").bind(uid).run();
    const { invalidateCachedSessionsOf } = await import('../src/lib/auth-cache.ts');
    invalidateCachedSessionsOf(uid);

    const me = await json('/api/v1/me');
    expect(me.status).toBe(403);
    expect((await me.json<{ error: string }>()).error).toBe('auth.account_banned');

    // 白名单：读取自身会话与登出
    const session = await json('/api/v1/auth/session');
    expect(session.status).toBe(200);
    expect((await session.json<{ role: string }>()).role).toBe('banned');
    expect((await json('/api/v1/auth/logout', undefined, 'POST')).status).toBe(204);

    // 登出后 access/refresh 全部失效
    expect((await json('/api/v1/auth/session')).status).toBe(401);
    const refresh = await SELF.fetch('https://x/api/v1/auth/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }),
    });
    expect(refresh.status).toBe(401);
  });

  it('兑换 code 只能消费一次', async () => {
    const login = await json('/api/v1/auth/login', { identifier: 'bearer-check@example.com', password: PASSWORD }, 'POST', '');
    expect(login.status).toBe(200);
    // 直接造一枚 web-exchange code（发放方 routes/oauth.ts 的行为已在 oauth-social 覆盖）
    const { hashToken } = await import('@pigeon-skin/auth');
    const code = 'a'.repeat(43);
    await env.DB.prepare("INSERT INTO oauth_login_states (id, provider, browser_hash, user_id, session_id, verifier, destination, expires_at) VALUES (?, 'web-exchange', '', ?, NULL, '', '/user', ?)")
      .bind(await hashToken(code), uid, Date.now() + 300000).run();
    const first = await json('/api/v1/auth/token', { code }, 'POST', '');
    expect(first.status).toBe(200);
    const second = await json('/api/v1/auth/token', { code }, 'POST', '');
    expect(second.status).toBe(401);
  });

  it('伪造与过期的 web_token 按匿名处理', async () => {
    const { createApp } = await import('../src/app.ts');
    const { createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
    const bindings = { ...env, GITHUB_CLIENT_ID: 'bearer-github', GITHUB_CLIENT_SECRET: 'bearer-secret' } as typeof env;
    const call = async (path: string) => {
      const ctx = createExecutionContext();
      const response = await createApp().fetch(new Request(`https://x${path}`, { redirect: 'manual' }), bindings, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };

    // web_token 无效 → 匿名 → 仍发起授权（state 不绑用户），而不是 500/401
    const started = await call('/auth/oauth/github?web_token=forged-token');
    expect(started.status).toBe(302);
    expect(started.headers.get('location')!).toContain('github.com');

    // 过期令牌同理：走客户端校验的常规错误路径，而不是令牌认证失败
    const { mintWebAccessToken } = await import('@pigeon-skin/auth');
    const expired = await mintWebAccessToken((env as unknown as { SESSION_SECRET: string }).SESSION_SECRET, uid, 'f'.repeat(64), -120);
    const stale = await call(`/yggc/authorize?${new URLSearchParams({ client_id: 'x', redirect_uri: 'https://x/cb', web_token: expired })}`);
    // invalid_client 的 401 JSON 说明请求走完了客户端校验：过期令牌没有引发认证失败
    expect(stale.status).toBe(401);
    expect((await stale.json<{ error: string }>()).error).toBe('invalid_client');
  });
});

describe('route-metadata', () => {
  it('认证端点豁免清单与前端一致（logout 不在列）', () => {
    for (const prefix of AUTH_BODY_PREFIXES) expect(isAuthBodyPath(prefix)).toBe(true);
    expect(isAuthBodyPath('/api/v1/auth/logout')).toBe(false);
    expect(isAuthBodyPath('/api/v1/auth/session')).toBe(false);
    expect(isAuthBodyPath('/api/v1/auth/2fa/verify')).toBe(true);
  });
});
