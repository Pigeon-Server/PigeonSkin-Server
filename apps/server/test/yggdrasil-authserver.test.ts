// authserver 认证链路回归 —— HMCL 启动器实测暴露的两个缺陷：
//   1. 一次登录并行发两个相同 authenticate，第二个被限流判
//      403 ForbiddenOperationException("Too many requests")；
//   2. ygg_disable_authserver 打开后 refresh/validate 一并 403，
//      已登录的启动器集体失效（「Traditional authentication is disabled」）。
/// <reference types="@cloudflare/vitest-pool-workers" />

import { invalidateSettingsCache } from './../src/core/settings-reader.ts';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { hashPassword, hashToken } from '@pigeon-skin/auth';
import { runMigrations } from './setup.ts';

const PASSWORD = 'correct-horse-9';
// 限流键取 x-forwarded-for 首段，测试里显式带上以固定 IP 维度的判定
const IP = '203.0.113.7';

let seq = 0;
function uniq(prefix: string): string {
  return `${prefix}_${++seq}_${Date.now().toString(36).replace(/[^a-z0-9]/g, '').slice(-6)}`;
}

async function registerUser(): Promise<{ id: number; email: string; playerName: string }> {
  const email = `${uniq('u')}@example.com`;
  const playerName = uniq('p');
  const res = await SELF.fetch('https://x/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, playerName }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ id: number }>();
  return { id: body.id, email, playerName };
}

interface AuthResponse {
  accessToken: string;
  clientToken: string;
  availableProfiles: Array<{ id: string; name: string }>;
  selectedProfile?: { id: string; name: string };
}

async function authenticate(username: string, password = PASSWORD): Promise<Response> {
  return SELF.fetch('https://x/api/yggdrasil/authserver/authenticate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
    body: JSON.stringify({ username, password }),
  });
}

/** 预置一条 ageMs 毫秒前的认证尝试（identifier 维度），驱动限流判定 */
async function seedAttempt(username: string, ageMs: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at) VALUES (?, ?, 'ygg', 1, ?)",
  ).bind(IP, await hashToken(username.toLowerCase()), Date.now() - ageMs).run();
}

async function writeSetting(key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings(key,locale,value,updated_at) VALUES(?, '', ?, ?) ON CONFLICT(key,locale) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).bind(key, value, Date.now()).run();
  invalidateSettingsCache();
}

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE kind IN ('ygg', 'ygg-ip')").run();
  // 设置缓存按 isolate 存活，跨用例必须作废，否则上一用例写入的开关值会遮蔽本用例
  invalidateSettingsCache();
});

describe('authserver 限流', () => {
  it('HMCL 并行双发：同一账号的两个并发 authenticate 都放行', async () => {
    await writeSetting('ygg_rate_limit', '10000');
    const u = await registerUser();
    const [a, b] = await Promise.all([authenticate(u.email), authenticate(u.email)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const first = await a.json<AuthResponse>();
    const second = await b.json<AuthResponse>();
    expect(first.accessToken).toBeTruthy();
    expect(second.accessToken).not.toBe(first.accessToken);
  });

  it('宽限内的重复请求放行（触达凭据校验而非限流）', async () => {
    await writeSetting('ygg_rate_limit', '10000');
    const u = await registerUser();
    await seedAttempt(u.email, 500);
    const res = await authenticate(u.email, 'wrong-password');
    expect(res.status).toBe(403);
    expect((await res.json<{ errorMessage: string }>()).errorMessage).toContain('Invalid credentials');
  });

  it('超出宽限但仍在窗口内的重试被限流', async () => {
    await writeSetting('ygg_rate_limit', '10000');
    const u = await registerUser();
    await seedAttempt(u.email, 5000);
    const res = await authenticate(u.email);
    expect(res.status).toBe(403);
    expect((await res.json<{ errorMessage: string }>()).errorMessage).toContain('Too many requests');
  });

  it('宽限不是无限突发：同窗口第三笔起拦截', async () => {
    await writeSetting('ygg_rate_limit', '10000');
    const u = await registerUser();
    // 宽限窗内已有一笔 → 第二笔仍在宽限内放行（触达凭据校验），但窗口已满两笔
    await seedAttempt(u.email, 450);
    const first = await authenticate(u.email, 'wrong-password');
    expect(first.status).toBe(403);
    expect((await first.json<{ errorMessage: string }>()).errorMessage).toContain('Invalid credentials');
    const second = await authenticate(u.email);
    expect(second.status).toBe(403);
    expect((await second.json<{ errorMessage: string }>()).errorMessage).toContain('Too many requests');
  });

  it('窗口过期后放行，且 IP 维度对同 IP 的其他账号仍然生效', async () => {
    await writeSetting('ygg_rate_limit', '10000');
    const u = await registerUser();
    await seedAttempt(u.email, 11000);
    const ok = await authenticate(u.email, 'wrong-password');
    expect(ok.status).toBe(403);
    expect((await ok.json<{ errorMessage: string }>()).errorMessage).toContain('Invalid credentials');

    const other = `${uniq('v')}@example.com`;
    await env.DB.prepare(
      "INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at) VALUES (?, NULL, 'ygg-ip', 0, ?)",
    ).bind(IP, Date.now() - 5000).run();
    const blocked = await authenticate(other, 'wrong-password');
    expect(blocked.status).toBe(403);
    expect((await blocked.json<{ errorMessage: string }>()).errorMessage).toContain('Too many requests');
  });
});

describe('ygg_disable_authserver 作用域', () => {
  it('关闭后 authenticate/signout 被拒，refresh/validate/invalidate 仍可用', async () => {
    const u = await registerUser();
    const before = await authenticate(u.email);
    expect(before.status).toBe(200);
    const auth = await before.json<AuthResponse>();

    await writeSetting('ygg_disable_authserver', 'true');
    try {
      const denied = await authenticate(u.email);
      expect(denied.status).toBe(403);
      expect((await denied.json<{ errorMessage: string }>()).errorMessage).toBe('Traditional authentication is disabled.');

      const signout = await SELF.fetch('https://x/api/yggdrasil/authserver/signout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
        body: JSON.stringify({ username: u.email, password: PASSWORD }),
      });
      expect(signout.status).toBe(403);

      const validate = await SELF.fetch('https://x/api/yggdrasil/authserver/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: auth.accessToken, clientToken: auth.clientToken }),
      });
      expect(validate.status).toBe(204);

      const refresh = await SELF.fetch('https://x/api/yggdrasil/authserver/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: auth.accessToken, clientToken: auth.clientToken }),
      });
      expect(refresh.status).toBe(200);
      const refreshed = await refresh.json<AuthResponse>();

      const invalidate = await SELF.fetch('https://x/api/yggdrasil/authserver/invalidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: refreshed.accessToken }),
      });
      expect(invalidate.status).toBe(204);
    } finally {
      await writeSetting('ygg_disable_authserver', 'false');
    }
  });
});

describe('HMCL 登录序列（多角色邮箱登录）', () => {
  it('authenticate 无 selectedProfile → refresh 绑定本地记忆的角色', async () => {
    await writeSetting('ygg_rate_limit', '0');
    const now = Date.now();
    const email = `${uniq('hm')}@example.com`;
    const uid = (await env.DB.prepare(
      'INSERT INTO users (email, nickname, password_hash, role, score, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    ).bind(email, 'HMCL User', await hashPassword(PASSWORD), 'normal', 1000, now, now, now).first<{ id: number }>())!.id;
    const first = await env.DB.prepare('INSERT INTO players (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(uid, uniq('first'), now, now).first<{ id: number }>();
    expect(first?.id).toBeTruthy();
    await env.DB.prepare('INSERT INTO players (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(uid, uniq('second'), now, now).run();

    const res = await authenticate(email);
    expect(res.status).toBe(200);
    const auth = await res.json<AuthResponse>();
    expect(auth.availableProfiles).toHaveLength(2);
    // 邮箱登录 + 多角色：不替客户端选角色，由启动器按本地记忆的 profileID 发 refresh 绑定
    expect(auth.selectedProfile).toBeUndefined();

    const remembered = auth.availableProfiles[0]!;
    const bind = await SELF.fetch('https://x/api/yggdrasil/authserver/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: auth.accessToken, clientToken: auth.clientToken, selectedProfile: remembered }),
    });
    expect(bind.status).toBe(200);
    const bound = await bind.json<AuthResponse>();
    expect(bound.selectedProfile?.id).toBe(remembered.id);

    // 绑定后的令牌可以过 join 校验链路的令牌检查（validate）
    const validate = await SELF.fetch('https://x/api/yggdrasil/authserver/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: bound.accessToken, clientToken: bound.clientToken }),
    });
    expect(validate.status).toBe(204);
  });
});
