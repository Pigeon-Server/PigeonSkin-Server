// Redis 可选驱动层的连接管理。
//
// 设计取向：REDIS_URL 未配置时整套 Redis 驱动不存在（getRedis 返回
// undefined，各工厂回退内存/SQLite 实现），部署零依赖、零行为变化；
// 配置后缓存/限流/队列三处才切换到 Redis。ioredis 因此必须懒加载——
// 动态 import 只在首次 getRedis() 时执行，bundle 构建时把 ioredis 标为
// external（scripts/build-node.mjs），运行时 node_modules 里有即可，
// 避免把 ~100KB 的客户端内联进单文件 bundle、也让未用 Redis 的部署
// 完全不触碰这个依赖。
//
// 连接参数刻意保持最小：业务量级（缓存 TTL、限流窗口、队列轮询）不需要
// 连接池调优；lazyConnect 让"Redis 没起"这种故障延迟到第一条命令才暴露，
// 由各命令的调用方决定 fail 语义（限流 fail-open、队列 fail 重试）。
// offline queue 保持默认开启：短暂断连/重连窗口内的命令排队而不是立即
// 报错，长断连由 retryStrategy 重连兜底。

let cached: import('ioredis').Redis | undefined;
let resolved = false;

/** REDIS_URL（如 redis://127.0.0.1:6379）；空串视为未配置 */
export function redisUrl(): string | undefined {
  const value = process.env.REDIS_URL;
  return value === undefined || value === '' ? undefined : value;
}

/** 是否启用 Redis 驱动（只看配置，不探测连通性） */
export function isRedisEnabled(): boolean {
  return redisUrl() !== undefined;
}

/**
 * 懒加载单例。未配置 REDIS_URL 返回 undefined；配置后首次调用才
 * import('ioredis') 并建连（lazyConnect，失败随命令报错）。
 */
export async function getRedis(): Promise<import('ioredis').Redis | undefined> {
  const url = redisUrl();
  if (url === undefined) return undefined;
  if (cached !== undefined) return cached;
  if (resolved) return undefined; // 并发首次调用：等第一个 import 完成的窗口内直接等下一轮
  resolved = true;
  const { default: Redis } = await import('ioredis');
  cached = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    // 断连后不无限重试打日志：短间隔重连即可，命令侧按需兜底
    retryStrategy: times => Math.min(times * 200, 2000),
  });
  return cached;
}

/** 关闭连接（runtime.stop() 与测试清理用） */
export async function closeRedis(): Promise<void> {
  if (cached === undefined) return;
  const client = cached;
  cached = undefined;
  resolved = false;
  await client.quit().catch(() => client.disconnect());
}

/** 测试专用：注入外部连接（绕过环境变量），生产代码不得使用 */
export function setRedisForTest(client: import('ioredis').Redis | undefined): void {
  cached = client;
  resolved = client !== undefined;
}
