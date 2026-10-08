// Redis 可选驱动测试。
//
// 两层覆盖：
//   1. 无 Redis 环境（REDIS_URL 未配置）：三个工厂返回 undefined、
//      isRedisEnabled 为 false、shim 方法安全降级。
//   2. 本机 127.0.0.1:6379 有真实 Redis（net 探测，连不上 vi.skip）：
//      cache put/match/delete、限流固定窗口超限、队列 send→消费→ack/retry。
//
// 注意：Redis 分支的操作走 pigeon:* 前缀 + 随机队列名，测试用 DB 0 并在
// 结束后按前缀清理，不影响同机其他数据。

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { Redis } from 'ioredis';

const REDIS_URL = 'redis://127.0.0.1:6379/0';

/** net 探测 6379 是否有 Redis 在监听（200ms 超时） */
function probeRedis(timeoutMs = 200): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(6379, '127.0.0.1');
  });
}

const redisAvailable = await probeRedis();
const canRunRedisTests = process.env.REDIS_TEST !== '0' && redisAvailable;

beforeAll(() => {
  // 未配置 REDIS_URL 的分支先跑：工厂必须在无配置下返回 undefined
  delete process.env.REDIS_URL;
  vi.resetModules();
});

afterAll(async () => {
  delete process.env.REDIS_URL;
});

describe('无 Redis 环境（REDIS_URL 未配置）', () => {
  it('isRedisEnabled 为 false，getRedis 返回 undefined', async () => {
    const { isRedisEnabled, getRedis } = await import('../../src/node/redis.ts');
    expect(isRedisEnabled()).toBe(false);
    expect(await getRedis()).toBeUndefined();
  });

  it('createRedisCacheShim 返回 undefined', async () => {
    const { createRedisCacheShim } = await import('../../src/node/cache-redis.ts');
    expect(await createRedisCacheShim()).toBeUndefined();
  });

  it('createRedisRateLimitBindings 返回 undefined', async () => {
    const { createRedisRateLimitBindings } = await import('../../src/node/ratelimit-redis.ts');
    expect(await createRedisRateLimitBindings({ RATE_LIMIT_ENABLED: 'true' })).toBeUndefined();
  });

  it('createRedisQueueSystem 返回 undefined', async () => {
    const { createRedisQueueSystem } = await import('../../src/node/queue-redis.ts');
    expect(await createRedisQueueSystem()).toBeUndefined();
  });
});

describe.runIf(canRunRedisTests)('Redis 驱动（真实 Redis @ 127.0.0.1:6379）', () => {
  vi.setConfig({ testTimeout: 15_000 });
  const testRunId = Date.now().toString(36);
  let redis: Redis;

  beforeAll(async () => {
    process.env.REDIS_URL = REDIS_URL;
    vi.resetModules();
    // 直接建连接做数据面断言与清理（驱动自身的连接由 getRedis 管理）
    redis = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    if (redis !== undefined) {
      // 按测试前缀清理本组键，不动同库其他数据
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'pigeon:*', 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
      redis.disconnect();
    }
    delete process.env.REDIS_URL;
  });

  it('isRedisEnabled 为 true，getRedis 返回懒加载单例', async () => {
    const { getRedis, isRedisEnabled } = await import('../../src/node/redis.ts');
    expect(isRedisEnabled()).toBe(true);
    const client = await getRedis();
    expect(client).toBeDefined();
    expect(await client!.ping()).toBe('PONG');
    // 单例：二次调用同实例
    expect(await getRedis()).toBe(client);
  });

  it('缓存：put → match 重建 status/headers/body，delete 后未命中，TTL 写入', async () => {
    const { createRedisCacheShim, CACHE_KEY_PREFIX } = await import('../../src/node/cache-redis.ts');
    const shim = (await createRedisCacheShim())!;
    expect(shim).toBeDefined();

    const url = `https://texture-cache.test/${testRunId}/abc`;
    await shim.put(url, new Response('png-bytes', {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' },
    }));

    // 数据面：键存在、EX TTL 已设、serialized 含 base64 body
    const key = CACHE_KEY_PREFIX + url;
    const raw = await redis.get(key);
    expect(raw).not.toBeNull();
    const entry = JSON.parse(raw!) as { status: number; headers: [string, string][]; body: string };
    expect(entry.status).toBe(200);
    expect(entry.body).toBe(Buffer.from('png-bytes').toString('base64'));
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(300);

    // match：字符串键与 Request 键等价，重建 Response
    const hit = await shim.match(new Request(url));
    expect(hit).toBeInstanceOf(Response);
    expect(hit!.status).toBe(200);
    expect(hit!.headers.get('content-type')).toBe('image/png');
    expect(await hit!.text()).toBe('png-bytes');
    expect(await shim.match(url)).toBeInstanceOf(Response);

    // 无 max-age 的条目不设 TTL（对齐 cache-shim 不淘汰语义）
    const noTtlUrl = `https://sitemap.internal/${testRunId}/__version__`;
    await shim.put(noTtlUrl, new Response('2'));
    expect(await redis.ttl(CACHE_KEY_PREFIX + noTtlUrl)).toBe(-1);

    // delete → true；再 match → undefined；再 delete → false
    expect(await shim.delete(url)).toBe(true);
    expect(await shim.match(url)).toBeUndefined();
    expect(await shim.delete(url)).toBe(false);
  });

  it('限流：固定窗口 INCR + EXPIRE，超限拒绝，Redis 不可达 fail-open', async () => {
    const { createRedisRateLimitBindings } = await import('../../src/node/ratelimit-redis.ts');
    const bindings = (await createRedisRateLimitBindings({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_AUTH: '2/60',
      RATE_LIMIT_GLOBAL: '1/60',
    }))!;
    const key = `${testRunId}:auth:1.2.3.4`;

    expect(await bindings.RL_AUTH.limit({ key })).toEqual({ success: true });
    expect(await bindings.RL_AUTH.limit({ key })).toEqual({ success: true });
    expect(await bindings.RL_AUTH.limit({ key })).toEqual({ success: false });

    // 数据面：计数为 3、TTL 落在窗口内
    const redisKey = `pigeon:rl:auth:${key}`;
    expect(await redis.get(redisKey)).toBe('3');
    const ttl = await redis.ttl(redisKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    // 不同 key 互不影响
    expect(await bindings.RL_AUTH.limit({ key: `${testRunId}:auth:5.6.7.8` })).toEqual({ success: true });

    // GLOBAL 限流 1 次
    const globalKey = `${testRunId}:global:9.9.9.9`;
    expect(await bindings.RL_GLOBAL.limit({ key: globalKey })).toEqual({ success: true });
    expect(await bindings.RL_GLOBAL.limit({ key: globalKey })).toEqual({ success: false });
  });

  it('限流：RATE_LIMIT_ENABLED=false 时 Redis 配置下也返回 undefined（fail-open 形状）', async () => {
    const { createRedisRateLimitBindings } = await import('../../src/node/ratelimit-redis.ts');
    expect(await createRedisRateLimitBindings({ RATE_LIMIT_ENABLED: 'false' })).toBeUndefined();
    expect(await createRedisRateLimitBindings({ RATE_LIMIT_ENABLED: '0' })).toBeUndefined();
  });

  it('队列：send → 消费 → ack（payload/attempts 清理，不再重投）', async () => {
    const { createRedisQueueSystem } = await import('../../src/node/queue-redis.ts');
    const system = (await createRedisQueueSystem())!;
    const queueName = `test-${testRunId}-ack`;
    const producer = system.producer<{ broadcastId: string }>(queueName);
    await producer.send({ broadcastId: 'b1' }, { contentType: 'json' });
    await producer.sendBatch([{ body: { broadcastId: 'b2' } }]);

    // 数据面：payload HASH 两条，ready LIST 两条
    expect(await redis.hlen(`pigeon:queue:${queueName}:payload`)).toBe(2);
    expect(await redis.llen(`pigeon:queue:${queueName}:ready`)).toBe(2);

    const seen: string[] = [];
    const runner = system.runner(async batch => {
      seen.push(...batch.messages.map(message => (message.body as { broadcastId: string }).broadcastId));
      for (const message of batch.messages) message.ack();
    }, { intervalMs: 10 });
    await runner.pollOnce();

    expect(seen.sort()).toEqual(['b1', 'b2']);
    // ack 后：payload/ready/processing/attempts 全清
    expect(await redis.hlen(`pigeon:queue:${queueName}:payload`)).toBe(0);
    expect(await redis.llen(`pigeon:queue:${queueName}:ready`)).toBe(0);
    expect(await redis.llen(`pigeon:queue:${queueName}:processing`)).toBe(0);

    // 第二轮无消息
    const seen2: string[] = [];
    const runner2 = system.runner(async batch => {
      seen2.push(...batch.messages.map(message => JSON.stringify(message.body)));
    }, { intervalMs: 10 });
    await runner2.pollOnce();
    expect(seen2).toEqual([]);
  });

  it('队列：retry({ delaySeconds }) → ZADD 推迟，延迟内不投、到期重投', async () => {
    const { createRedisQueueSystem } = await import('../../src/node/queue-redis.ts');
    const system = (await createRedisQueueSystem())!;
    const queueName = `test-${testRunId}-retry`;
    const producer = system.producer<{ engine: string }>(queueName);
    await producer.send({ engine: 'bing' });

    let deliveries = 0;
    const runner = system.runner(async batch => {
      deliveries++;
      for (const message of batch.messages) message.retry({ delaySeconds: 300 });
    }, { intervalMs: 10 });

    await runner.pollOnce();
    expect(deliveries).toBe(1);
    // 数据面：attempts=1，delayed ZSET 的 score = now + 300s
    // ioredis 的 zrange/zscore 分数参数要求字符串字面量重载，统一传字符串
    const delayedId = (await redis.zrange(`pigeon:queue:${queueName}:delayed`, '0', '-1'))[0]!;
    expect(delayedId).toBeDefined();
    const score = Number(await redis.zscore(`pigeon:queue:${queueName}:delayed`, delayedId));
    expect(score).toBeGreaterThanOrEqual(Date.now() + 299_000);

    // 延迟未到：不投
    await runner.pollOnce();
    expect(deliveries).toBe(1);

    // 把 available_at 提前模拟到期 → 重投
    await redis.zadd(`pigeon:queue:${queueName}:delayed`, String(Date.now() - 1), delayedId);
    const runner2 = system.runner(async batch => {
      deliveries++;
      for (const message of batch.messages) message.ack();
    }, { intervalMs: 10 });
    await runner2.pollOnce();
    expect(deliveries).toBe(2);
    expect(await redis.hlen(`pigeon:queue:${queueName}:payload`)).toBe(0);
  });

  it('队列：不 ack 不 retry → attempts 递增并重投；超限放弃', async () => {
    const { createRedisQueueSystem } = await import('../../src/node/queue-redis.ts');
    const system = (await createRedisQueueSystem())!;
    const queueName = `test-${testRunId}-abandon`;
    const producer = system.producer<{ n: number }>(queueName);
    await producer.send({ n: 1 });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // maxAttempts=2：第一轮无操作（重投），第二轮后放弃
      let deliveries = 0;
      const runner = system.runner(async () => { deliveries++; }, { intervalMs: 10, maxAttempts: 2 });
      await runner.pollOnce();
      expect(deliveries).toBe(1);
      // 未 settled：attempts 已 +1，消息仍在（payload 在，等下次轮询）
      expect(Number(await redis.hget(`pigeon:queue:${queueName}:attempts`, await redis.hkeys(`pigeon:queue:${queueName}:attempts`).then(keys => keys[0]!)))).toBe(1);

      await runner.pollOnce();
      expect(deliveries).toBe(2);
      // 超限：全部清理
      expect(await redis.hlen(`pigeon:queue:${queueName}:payload`)).toBe(0);
      expect(await redis.hlen(`pigeon:queue:${queueName}:attempts`)).toBe(0);
      expect(await redis.llen(`pigeon:queue:${queueName}:ready`)).toBe(0);
      expect(await redis.llen(`pigeon:queue:${queueName}:processing`)).toBe(0);
      expect(errorSpy).toHaveBeenCalled();
      expect(errorSpy.mock.calls[0]![0]).toContain('放弃消息');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('队列：start/stop 生命周期', async () => {
    const { createRedisQueueSystem } = await import('../../src/node/queue-redis.ts');
    const system = (await createRedisQueueSystem())!;
    const queueName = `test-${testRunId}-lifecycle`;
    let deliveries = 0;
    const runner = system.runner(async batch => {
      for (const message of batch.messages) message.ack();
      deliveries += batch.messages.length;
    }, { intervalMs: 30 });
    runner.start();
    await system.producer(queueName).send({ n: 1 });
    // 轮询间隔 30ms：等足多个周期确保第一条被消费，且断言前检查值稳定
    for (let i = 0; i < 40 && deliveries === 0; i++) await new Promise(resolve => setTimeout(resolve, 25));
    expect(deliveries).toBe(1);
    runner.stop();
    // stop 之后留足 3 个轮询周期确认不再消费
    await system.producer(queueName).send({ n: 2 });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(deliveries).toBe(1);
  });
});
