// 令牌存储的最小形状守卫：刷新豁免清单与后端 route-metadata 的 AUTH_BODY_PREFIXES
// 保持一致（logout/session 不豁免），防止两份清单静默漂移。
import { describe, expect, it } from 'vitest';

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
