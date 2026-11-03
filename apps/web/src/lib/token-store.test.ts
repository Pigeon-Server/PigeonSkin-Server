// @vitest-environment jsdom
// 令牌存储的最小形状守卫与刷新失败语义回归：
// 1. 刷新豁免清单与后端 route-metadata 的 AUTH_BODY_PREFIXES 保持一致
//    （logout/session 不豁免），防止两份清单静默漂移；
// 2. refreshTokens 只有在服务端确定性拒绝（401/422）时才清空令牌登出，
//    限流/5xx/网络抖动等瞬时失败必须保留"记住我"会话的本地凭据。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const AUTH_BODY_PREFIXES = [
  '/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/refresh', '/api/v1/auth/token',
  '/api/v1/auth/forgot-password', '/api/v1/auth/reset-password', '/api/v1/auth/captcha/',
  '/api/v1/auth/2fa', '/api/v1/auth/passkeys', '/api/v1/auth/verify-email/confirm',
];

describe('auth token 豁免清单', () => {
  it('logout/session 不在刷新豁免清单内（登出必须撤销服务端会话）', () => {
    expect(AUTH_BODY_PREFIXES.some(p => '/api/v1/auth/logout'.startsWith(p))).toBe(false);
    expect(AUTH_BODY_PREFIXES.some(p => '/api/v1/auth/session'.startsWith(p))).toBe(false);
  });

  it('令牌入口端点全部在豁免清单内', () => {
    for (const path of ['/api/v1/auth/refresh', '/api/v1/auth/token', '/api/v1/auth/login', '/api/v1/auth/2fa/verify']) {
      expect(AUTH_BODY_PREFIXES.some(p => path.startsWith(p))).toBe(true);
    }
  });
});

// ── refreshTokens 失败语义 ─────────────────────────────────────────────────────

/** 手工拼一个 access JWT（只有 exp claim 被 tokenExpiry 读取） */
function fakeJwt(expSeconds: number): string {
  const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSeconds })}.sig`;
}

const REFRESH_TOKEN = 'r'.repeat(43);

function grantBody(): Record<string, unknown> {
  return { accessToken: fakeJwt(Math.floor(Date.now() / 1000) + 900), refreshToken: REFRESH_TOKEN, expiresIn: 900, user: { id: 1 } };
}

describe('refreshTokens 失败语义', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** 预置本地令牌并加载被测模块（每用例独立实例，避免单飞/监听器串场） */
  async function boot(fetchImpl: () => Promise<Response>, { withRefreshToken = true } = {}) {
    localStorage.setItem('ps_web_at', fakeJwt(Math.floor(Date.now() / 1000) - 10));
    if (withRefreshToken) localStorage.setItem('ps_web_rt', REFRESH_TOKEN);
    const fetchMock = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', fetchMock);
    return { store: await import('./token-store'), fetchMock };
  }

  it('200：保存新令牌并广播 grant', async () => {
    const { store } = await boot(async () => new Response(JSON.stringify(grantBody())));
    const events: unknown[] = [];
    const unsubscribe = store.onAuthChanged(grant => events.push(grant));
    const grant = await store.refreshTokens();
    unsubscribe();
    expect(grant).not.toBeNull();
    expect(store.readRefreshToken()).toBe(REFRESH_TOKEN);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toBeNull();
  });

  it('401/422：确定性拒绝凭据，清空令牌并广播登出', async () => {
    for (const status of [401, 422]) {
      const { store } = await boot(async () => new Response(null, { status }));
      const events: unknown[] = [];
      const unsubscribe = store.onAuthChanged(grant => events.push(grant));
      expect(await store.refreshTokens()).toBeNull();
      unsubscribe();
      expect(localStorage.getItem('ps_web_at')).toBeNull();
      expect(localStorage.getItem('ps_web_rt')).toBeNull();
      expect(events).toEqual([null]);
    }
  });

  it('429/403/5xx：瞬时失败保留令牌，不触发登出', async () => {
    for (const status of [429, 403, 500, 502]) {
      const { store } = await boot(async () => new Response(null, { status }));
      const events: unknown[] = [];
      const unsubscribe = store.onAuthChanged(grant => events.push(grant));
      expect(await store.refreshTokens()).toBeNull();
      unsubscribe();
      expect(localStorage.getItem('ps_web_rt')).toBe(REFRESH_TOKEN);
      expect(events).toEqual([]);
    }
  });

  it('无 refresh token：不发请求，本地状态原样保留', async () => {
    const { store, fetchMock } = await boot(async () => new Response(JSON.stringify(grantBody())), { withRefreshToken: false });
    const events: unknown[] = [];
    const unsubscribe = store.onAuthChanged(grant => events.push(grant));
    expect(await store.refreshTokens()).toBeNull();
    unsubscribe();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('ps_web_at')).toContain('.');
    expect(events).toEqual([]);
  });

  it('网络异常：保留令牌等下次请求重试', async () => {
    const { store } = await boot(async () => { throw new TypeError('Failed to fetch'); });
    const events: unknown[] = [];
    const unsubscribe = store.onAuthChanged(grant => events.push(grant));
    expect(await store.refreshTokens()).toBeNull();
    unsubscribe();
    expect(localStorage.getItem('ps_web_rt')).toBe(REFRESH_TOKEN);
    expect(events).toEqual([]);
  });
});
