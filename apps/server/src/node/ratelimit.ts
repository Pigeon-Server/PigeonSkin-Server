// Workers 原生 Rate Limiting binding 的 Node 侧等价物。
//
// Workers 上 binding 由平台实现（边缘聚合计数）；Node 单进程改为内存
// 固定窗口计数：以 periodSeconds 为窗口长度，对每个 key 维护
// "窗口起点 + 已放行请求数"，窗口翻页即重置。对限流这种纵深防御
// 机制，单进程内存近似完全够用。
//
// 对齐 security.ts 的用法：`limit({ key }) → Promise<{ success }>`，
// binding 缺失/关闭时返回 undefined，中间件 fail-open。

/** env.RL_GLOBAL / RL_AUTH 的形状（见 src/env.ts） */
export interface RateLimiterBinding {
  limit(params: { key: string }): Promise<{ success: boolean }>;
}

interface WindowState {
  /** 当前窗口起点（毫秒） */
  windowStart: number;
  count: number;
}

export class RateLimiterBindingShim implements RateLimiterBinding {
  readonly #limit: number;
  readonly #periodMs: number;
  readonly #windows = new Map<string, WindowState>();

  constructor(limit: number, periodSeconds: number) {
    if (!Number.isFinite(limit) || limit <= 0) throw new RangeError('limit 必须是正数');
    if (!Number.isFinite(periodSeconds) || periodSeconds <= 0) throw new RangeError('periodSeconds 必须是正数');
    this.#limit = limit;
    this.#periodMs = periodSeconds * 1000;
  }

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = Date.now();
    let window = this.#windows.get(key);
    if (!window || now - window.windowStart >= this.#periodMs) {
      // 新窗口覆盖旧窗口；key 无限增长由同一实例复用（IP 数量级）兜底
      window = { windowStart: now, count: 0 };
      this.#windows.set(key, window);
    }
    if (window.count >= this.#limit) return { success: false };
    window.count++;
    return { success: true };
  }
}

export interface RateLimitEnv {
  RATE_LIMIT_ENABLED?: string | undefined;
  /** 每周期请求数与窗口秒数，形如 "120/60" */
  RATE_LIMIT_GLOBAL?: string | undefined;
  RATE_LIMIT_AUTH?: string | undefined;
  RATE_LIMIT_SKINLIB?: string | undefined;
  RATE_LIMIT_SKINLIB_USER?: string | undefined;
}

/** 解析 "limit/periodSeconds" 配置；非法配置抛错（部署期就该发现）。
 *  导出供 ratelimit-redis.ts 复用同一配置格式与错误文案。 */
export function parseSpec(spec: string, name: string): { limit: number; periodSeconds: number } {
  const match = /^(\d+)\/(\d+)$/.exec(spec.trim());
  if (!match) throw new Error(`RATE_LIMIT_${name} 配置格式应为 "<次数>/<秒数>"，收到：${spec}`);
  return { limit: Number(match[1]), periodSeconds: Number(match[2]) };
}

/**
 * 构造限流 binding 集合。RATE_LIMIT_ENABLED=false（或显式 'false'/'0'）
 * 时返回 undefined——与 Workers 侧 wrangler 不配 ratelimits 时
 * binding 缺失相同，security.ts 中间件据此 fail-open。
 */
export function createRateLimitBindings(
  env: RateLimitEnv,
): {
  RL_GLOBAL: RateLimiterBinding;
  RL_AUTH: RateLimiterBinding;
  RL_SKINLIB: RateLimiterBinding;
  RL_SKINLIB_USER: RateLimiterBinding;
} | undefined {
  if (env.RATE_LIMIT_ENABLED === 'false' || env.RATE_LIMIT_ENABLED === '0') return undefined;
  return {
    RL_GLOBAL: new RateLimiterBindingShim(...splitSpec(env.RATE_LIMIT_GLOBAL ?? '120/60', 'GLOBAL')),
    RL_AUTH: new RateLimiterBindingShim(...splitSpec(env.RATE_LIMIT_AUTH ?? '10/60', 'AUTH')),
    RL_SKINLIB: new RateLimiterBindingShim(...splitSpec(env.RATE_LIMIT_SKINLIB ?? '60/60', 'SKINLIB')),
    RL_SKINLIB_USER: new RateLimiterBindingShim(...splitSpec(env.RATE_LIMIT_SKINLIB_USER ?? '300/60', 'SKINLIB_USER')),
  };
}

export function splitSpec(spec: string, name: string): [number, number] {
  const parsed = parseSpec(spec, name);
  return [parsed.limit, parsed.periodSeconds];
}
