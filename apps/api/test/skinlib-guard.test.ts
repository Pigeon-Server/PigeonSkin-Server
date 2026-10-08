// 皮肤库反爬守卫的集成测试：匿名紧桶 + 登录松桶 + 渐进式人机验证 + 通行证。
//
// 运行在 workerd 里，路径经由真实 Hono 应用；限流 binding 用可注入的假实现
// 精确控制阈值，验证码用 image 驱动（无外网依赖，题面可解析）。

import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createSession, sessionCookieName } from '../src/lib.ts';
import type { Bindings } from '../src/env.ts';
import { issueSkinlibPass, verifySkinlibPass } from '../src/middleware/skinlib-guard.ts';
import { runMigrations } from './setup.ts';

const IP = '203.0.113.7';
const SESSION_SECRET = 'test-session-secret';

function baseBindings(): Bindings {
  return {
    ...env,
    APP_URL: 'https://x',
    RATE_LIMIT_ENABLED: 'true',
    SKINLIB_GUARD_ENABLED: 'true',
    SESSION_SECRET,
  } as Bindings;
}

/** 可控限流器：按 key 固定窗口计数（测试内不复位窗口，够用） */
function fakeLimiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    counts,
    async limit({ key }: { key: string }) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { success: next <= limit };
    },
  };
}

async function call(
  path: string,
  override: Record<string, unknown> = {},
  init: RequestInit = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', IP);
  headers.set('sec-fetch-site', 'same-origin');
  const response = await createApp().fetch(
    new Request(`https://x${path}`, { ...init, headers }),
    { ...baseBindings(), ...override } as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** 从 image 验证码题面 SVG 里按顺序取出字符，还原答案 */
function solveImageCaptcha(svg: string): string {
  const chars = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]!);
  return chars.join('');
}

beforeAll(runMigrations);

describe('skinlib guard coverage', () => {
  it('covers the detail endpoint whatever numeric form the router accepts', async () => {
    // 路由用 Number() 解析 id，0x47F / +1151 / %311151 / 1151.0 都指向同一材质；
    // 守卫必须与路由同源匹配，否则换个写法就绕过了计数
    const limiter = fakeLimiter(0);
    const override = { RL_SKINLIB: limiter, CAPTCHA_DRIVER: 'image' };
    for (const path of [
      '/api/v1/textures/1',
      '/api/v1/textures/0x47F',
      '/api/v1/textures/+1151',
      '/api/v1/textures/1151.0',
      '/api/v1/textures/%31151',
      '/api/v1/textures/1/description',
    ]) {
      const res = await call(path, override);
      expect(res.status, path).toBe(429);
      expect((await res.json<{ error: string }>()).error, path).toBe('skinlib.challenge_required');
    }
    // HEAD 由 GET 处理器应答，同样计数
    const head = await call('/api/v1/textures/1', override, { method: 'HEAD' });
    expect(head.status).toBe(429);
  });

  it('never guards the content or comments endpoints', async () => {
    const limiter = fakeLimiter(0);
    const override = { RL_SKINLIB: limiter, CAPTCHA_DRIVER: 'image' };
    for (const path of ['/api/v1/textures/1/content', '/api/v1/textures/1/comments']) {
      const res = await call(path, override);
      expect(res.status, path).not.toBe(429);
    }
  });

  it('keeps every registered texture read route guarded or explicitly exempt', async () => {
    // 防漂移：未来新增 GET /api/v1/textures/... 子路由时必须显式决定纳入还是豁免
    const app = createApp();
    const guarded = app.routes
      .filter(r => r.method === 'ALL' && (r.handler as { name?: string }).name === 'skinlibGuardHandler')
      .map(r => r.path);
    expect([...guarded].sort()).toEqual([
      '/api/v1/textures',
      '/api/v1/textures/:id',
      '/api/v1/textures/:id/description',
    ]);

    const patternToRegex = (pattern: string) => new RegExp(`^${pattern.replace(/:[\w]+/g, '[^/]+')}$`);
    const covered = guarded.map(patternToRegex);
    const exempt = ['/api/v1/textures/:id/content', '/api/v1/textures/:id/comments'];
    const reads = app.routes
      .filter(r => r.method === 'GET' && r.path.startsWith('/api/v1/textures'))
      .map(r => r.path);
    expect(reads.length).toBeGreaterThan(0);
    for (const path of reads) {
      const isCovered = covered.some(pattern => pattern.test(path));
      expect(isCovered || exempt.includes(path), `${path} 既不在守卫挂载内也不在豁免清单`).toBe(true);
    }
  });
});

describe('skinlib guard pass tokens', () => {
  it('signs, verifies, rejects tampered and expired passes', async () => {
    const now = 1_000_000;
    const pass = await issueSkinlibPass({ SESSION_SECRET }, now);
    expect(pass).not.toBeNull();
    expect(await verifySkinlibPass({ SESSION_SECRET }, pass!, now)).toBe(true);
    // 换密钥、改签名、改过期时间都不通过
    expect(await verifySkinlibPass({ SESSION_SECRET: 'other' }, pass!, now)).toBe(false);
    expect(await verifySkinlibPass({ SESSION_SECRET }, pass!.replace(/.$/, 'x'), now)).toBe(false);
    const [expiresAt] = pass!.split('.');
    expect(await verifySkinlibPass({ SESSION_SECRET }, `${Number(expiresAt) + 60000}.f`, now)).toBe(false);
    // 过期
    expect(await verifySkinlibPass({ SESSION_SECRET }, pass!, now + 3600 * 1000 + 1)).toBe(false);
    // 无密钥时不签发也不通过
    expect(await issueSkinlibPass({})).toBeNull();
    expect(await verifySkinlibPass({}, pass!, now)).toBe(false);
  });
});

describe('anonymous visitors hit the tight bucket and get challenged', () => {
  it('allows under the limit, challenges over it, and accepts a solved captcha', async () => {
    const limiter = fakeLimiter(3);
    const override = { RL_SKINLIB: limiter, CAPTCHA_DRIVER: 'image' };

    for (let i = 0; i < 3; i++) {
      expect((await call('/api/v1/textures', override)).status).toBe(200);
    }

    const blocked = await call('/api/v1/textures', override);
    expect(blocked.status).toBe(429);
    expect((await blocked.json<{ error: string }>()).error).toBe('skinlib.challenge_required');

    // 未配置验证码时不弹无法完成的挑战，只返回普通限流
    const softLimited = await call('/api/v1/textures', { RL_SKINLIB: limiter });
    expect(softLimited.status).toBe(429);
    expect((await softLimited.json<{ error: string }>()).error).toBe('common.rate_limited');
    expect(softLimited.headers.get('set-cookie')).toBeNull();

    // 取题 → 解题 → 带 token 重试
    const challenge = await call('/api/v1/auth/captcha/challenge', override);
    expect(challenge.status).toBe(200);
    const { challengeId, svg } = await challenge.json<{ challengeId: string; svg: string }>();
    expect(challengeId).not.toBe('');
    const answer = solveImageCaptcha(svg);
    expect(answer).toHaveLength(4);

    const solved = await call('/api/v1/textures', override, {
      headers: { 'x-captcha-token': challengeId, 'x-captcha-randstr': answer },
    });
    expect(solved.status).toBe(200);
    const setCookies = (solved.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
    const passCookie = setCookies.find(v => v.startsWith('skinlib_pass='));
    expect(passCookie).toBeTruthy();
    expect(passCookie).toContain('Path=/api/v1/textures');
    expect(passCookie).toContain('HttpOnly');

    // 持证后用独立计数键放行：匿名桶已耗尽也照常浏览
    const passValue = passCookie!.split(';')[0]!;
    const passed = await call('/api/v1/textures', override, { headers: { cookie: passValue } });
    expect(passed.status).toBe(200);

    // 伪造通行证不通过，仍被挑战
    const forged = await call('/api/v1/textures', override, { headers: { cookie: `${passValue}x` } });
    expect(forged.status).toBe(429);
    expect((await forged.json<{ error: string }>()).error).toBe('skinlib.challenge_required');
  });

  it('issues a pass for a solved captcha even when the window rolled back under the limit', async () => {
    // 用户在 429 后解题期间 60s 窗口滚动回限额内：不能白解一次，照样发证
    const limiter = fakeLimiter(10);
    const override = { RL_SKINLIB: limiter, CAPTCHA_DRIVER: 'image' };
    const challenge = await call('/api/v1/auth/captcha/challenge', override);
    const { challengeId, svg } = await challenge.json<{ challengeId: string; svg: string }>();
    const solved = await call('/api/v1/textures', override, {
      headers: { 'x-captcha-token': challengeId, 'x-captcha-randstr': solveImageCaptcha(svg) },
    });
    expect(solved.status).toBe(200);
    const setCookies = (solved.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
    expect(setCookies.some(v => v.startsWith('skinlib_pass='))).toBe(true);
  });

  it('is enabled by default when the switch is absent', async () => {
    const limiter = fakeLimiter(0);
    const res = await call('/api/v1/textures', {
      RL_SKINLIB: limiter,
      CAPTCHA_DRIVER: 'image',
      SKINLIB_GUARD_ENABLED: undefined,
    });
    expect(res.status).toBe(429);
    expect((await res.json<{ error: string }>()).error).toBe('skinlib.challenge_required');
  });

  it('standstill when the guard or rate limiting is disabled', async () => {
    const limiter = fakeLimiter(0);
    const off = await call('/api/v1/textures', {
      RL_SKINLIB: limiter,
      CAPTCHA_DRIVER: 'image',
      SKINLIB_GUARD_ENABLED: 'false',
    });
    expect(off.status).toBe(200);
    const rateLimitOff = await call('/api/v1/textures', {
      RL_SKINLIB: limiter,
      CAPTCHA_DRIVER: 'image',
      RATE_LIMIT_ENABLED: 'false',
    });
    expect(rateLimitOff.status).toBe(200);
  });
});

describe('logged-in users use the looser bucket and are only rate limited', () => {
  it('never challenges an authenticated session', async () => {
    const now = Date.now();
    const userId = (await env.DB.prepare(
      "INSERT INTO users (email, nickname, password_hash, role, email_verified_at, created_at, updated_at) VALUES (?, 'Guard user', 'x', 'normal', ?, ?, ?) RETURNING id",
    ).bind(`guard-${crypto.randomUUID()}@example.com`, now, now, now).first<{ id: number }>())!.id;
    const session = await createSession(baseBindings(), userId, {});
    const cookie = `${sessionCookieName(baseBindings())}=${session.token}`;

    const userLimiter = fakeLimiter(2);
    const guestLimiter = fakeLimiter(0);
    const override = { RL_SKINLIB_USER: userLimiter, RL_SKINLIB: guestLimiter, CAPTCHA_DRIVER: 'image' };

    for (let i = 0; i < 2; i++) {
      const res = await call('/api/v1/textures', override, { headers: { cookie } });
      expect(res.status).toBe(200);
    }
    const limited = await call('/api/v1/textures', override, { headers: { cookie } });
    expect(limited.status).toBe(429);
    expect((await limited.json<{ error: string }>()).error).toBe('common.rate_limited');
    expect(limited.headers.get('set-cookie')).toBeNull();
    // 匿名桶从未被消耗：登录用户不占匿名配额
    expect(guestLimiter.counts.size).toBe(0);
  });
});
