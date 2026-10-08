// Workers Rate Limiting binding 的 Redis 驱动：接口与 ratelimit.ts 的
// RateLimiterBindingShim 相同（limit({ key }) → { success }）。
//
// 固定窗口计数用 INCR + EXPIRE：key 形如 pigeon:rl:<binding>:<key>，
// INCR 后值为 1（新窗口）时设 EXPIRE = 窗口秒数。与内存版一样是固定窗口
// 近似——窗口翻页靠 TTL 自然过期，计数器自身即窗口。
//
// 边界取舍：Redis 命令失败时 fail-open（返回 success: true）。限流是纵深
// 防御而非鉴权，Redis 抖动不该放大成全站 5xx；这与 binding 缺失时中间件
// fail-open 的既有语义一致。计数散列到 Redis 后天然多进程共享，这是相对
// 内存版的核心收益。

import { getRedis } from './redis.ts';
import { splitSpec } from './ratelimit.ts';

const PREFIX = 'pigeon:rl:';

export class RedisRateLimiterBinding {
  readonly #name: string;
  readonly #limit: number;
  readonly #periodSeconds: number;

  constructor(name: string, limit: number, periodSeconds: number) {
    this.#name = name;
    this.#limit = limit;
    this.#periodSeconds = periodSeconds;
  }

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const redis = await getRedis();
    if (redis === undefined) return { success: true };
    const redisKey = `${PREFIX}${this.#name}:${key}`;
    try {
      const count = await redis.incr(redisKey);
      // 首次 INCR 才设 TTL：值就是"当前窗口已请求数"，TTL 到期即窗口翻页
      if (count === 1) await redis.expire(redisKey, this.#periodSeconds);
      // count 越界的窗口（极旧 key 的 TTL 意外丢失）也拒绝：fail-closed
      // 比悄悄放行更接近限流语义
      return { success: count <= this.#limit };
    } catch {
      // Redis 不可达 fail-open（纵深防御机制不放大故障）
      return { success: true };
    }
  }
}

export interface RedisRateLimitEnv {
  RATE_LIMIT_ENABLED?: string | undefined;
  /** 每周期请求数与窗口秒数，形如 "120/60" */
  RATE_LIMIT_GLOBAL?: string | undefined;
  RATE_LIMIT_AUTH?: string | undefined;
  RATE_LIMIT_SKINLIB?: string | undefined;
  RATE_LIMIT_SKINLIB_USER?: string | undefined;
}

/**
 * 构造 Redis 限流 binding 集合；未启用 Redis 返回 undefined（runtime
 * 回退内存版）。配置解析复用 ratelimit.ts 的 splitSpec（同格式同报错）。
 */
export async function createRedisRateLimitBindings(
  env: RedisRateLimitEnv,
): Promise<
  {
    RL_GLOBAL: RedisRateLimiterBinding;
    RL_AUTH: RedisRateLimiterBinding;
    RL_SKINLIB: RedisRateLimiterBinding;
    RL_SKINLIB_USER: RedisRateLimiterBinding;
  } | undefined
> {
  const { isRedisEnabled } = await import('./redis.ts');
  if (!isRedisEnabled()) return undefined;
  if (env.RATE_LIMIT_ENABLED === 'false' || env.RATE_LIMIT_ENABLED === '0') return undefined;
  const [globalLimit, globalPeriod] = splitSpec(env.RATE_LIMIT_GLOBAL ?? '120/60', 'GLOBAL');
  const [authLimit, authPeriod] = splitSpec(env.RATE_LIMIT_AUTH ?? '10/60', 'AUTH');
  const [skinlibLimit, skinlibPeriod] = splitSpec(env.RATE_LIMIT_SKINLIB ?? '60/60', 'SKINLIB');
  const [skinlibUserLimit, skinlibUserPeriod] = splitSpec(env.RATE_LIMIT_SKINLIB_USER ?? '300/60', 'SKINLIB_USER');
  return {
    RL_GLOBAL: new RedisRateLimiterBinding('global', globalLimit, globalPeriod),
    RL_AUTH: new RedisRateLimiterBinding('auth', authLimit, authPeriod),
    RL_SKINLIB: new RedisRateLimiterBinding('skinlib', skinlibLimit, skinlibPeriod),
    RL_SKINLIB_USER: new RedisRateLimiterBinding('skinlib-user', skinlibUserLimit, skinlibUserPeriod),
  };
}
