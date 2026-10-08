// 限流器测试：超限拒绝、窗口重置、开关与 fail-open 形状。

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiterBindingShim, createRateLimitBindings } from '../../src/node/ratelimit.ts';

describe('RateLimiterBindingShim', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('窗口内超限拒绝：前 limit 次放行，之后拒绝', async () => {
    const binding = new RateLimiterBindingShim(3, 60);
    expect(await binding.limit({ key: 'api:1.2.3.4' })).toEqual({ success: true });
    expect(await binding.limit({ key: 'api:1.2.3.4' })).toEqual({ success: true });
    expect(await binding.limit({ key: 'api:1.2.3.4' })).toEqual({ success: true });
    expect(await binding.limit({ key: 'api:1.2.3.4' })).toEqual({ success: false });
    expect(await binding.limit({ key: 'api:1.2.3.4' })).toEqual({ success: false });
    // 不同 key 互不影响（中间件的 key 形如 auth:<ip> / api:<ip>）
    expect(await binding.limit({ key: 'auth:1.2.3.4' })).toEqual({ success: true });
  });

  it('窗口翻页重置计数', async () => {
    const binding = new RateLimiterBindingShim(2, 10);
    expect(await binding.limit({ key: 'k' })).toEqual({ success: true });
    expect(await binding.limit({ key: 'k' })).toEqual({ success: true });
    expect(await binding.limit({ key: 'k' })).toEqual({ success: false });
    // 窗口期过去 → 计数归零
    vi.advanceTimersByTime(10_001);
    expect(await binding.limit({ key: 'k' })).toEqual({ success: true });
    expect(await binding.limit({ key: 'k' })).toEqual({ success: true });
    expect(await binding.limit({ key: 'k' })).toEqual({ success: false });
  });

  it('构造参数非法时报错', () => {
    expect(() => new RateLimiterBindingShim(0, 60)).toThrow(RangeError);
    expect(() => new RateLimiterBindingShim(10, 0)).toThrow(RangeError);
  });
});

describe('createRateLimitBindings', () => {
  it('RATE_LIMIT_ENABLED=false 时返回 undefined（中间件 fail-open）', () => {
    expect(createRateLimitBindings({ RATE_LIMIT_ENABLED: 'false' })).toBeUndefined();
    expect(createRateLimitBindings({ RATE_LIMIT_ENABLED: '0' })).toBeUndefined();
  });

  it('开启时返回 RL_GLOBAL/RL_AUTH binding，配置可覆盖默认', async () => {
    const bindings = createRateLimitBindings({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_GLOBAL: '2/60',
      RATE_LIMIT_AUTH: '1/60',
    });
    expect(bindings).toBeDefined();
    expect(await bindings!.RL_AUTH.limit({ key: 'auth:9.9.9.9' })).toEqual({ success: true });
    expect(await bindings!.RL_AUTH.limit({ key: 'auth:9.9.9.9' })).toEqual({ success: false });
    expect(await bindings!.RL_GLOBAL.limit({ key: 'api:9.9.9.9' })).toEqual({ success: true });
    expect(await bindings!.RL_GLOBAL.limit({ key: 'api:9.9.9.9' })).toEqual({ success: true });
    expect(await bindings!.RL_GLOBAL.limit({ key: 'api:9.9.9.9' })).toEqual({ success: false });
  });

  it('非法配置格式抛错（部署期暴露）', () => {
    expect(() => createRateLimitBindings({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_GLOBAL: 'nonsense' })).toThrow();
  });

  it('皮肤库双桶默认阈值：访客 60/60 紧于登录 300/60', async () => {
    const bindings = createRateLimitBindings({ RATE_LIMIT_ENABLED: 'true' });
    expect(bindings).toBeDefined();
    for (let i = 0; i < 60; i++) {
      expect(await bindings!.RL_SKINLIB.limit({ key: 'skinlib-guest:9.9.9.9' })).toEqual({ success: true });
    }
    expect(await bindings!.RL_SKINLIB.limit({ key: 'skinlib-guest:9.9.9.9' })).toEqual({ success: false });
    // 登录桶更宽松，且与访客桶 key 隔离
    for (let i = 0; i < 300; i++) {
      expect(await bindings!.RL_SKINLIB_USER.limit({ key: 'skinlib-user:7' })).toEqual({ success: true });
    }
    expect(await bindings!.RL_SKINLIB_USER.limit({ key: 'skinlib-user:7' })).toEqual({ success: false });
  });
});
