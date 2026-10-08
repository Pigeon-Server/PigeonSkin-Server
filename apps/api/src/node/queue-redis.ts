// 队列的 Redis 驱动：接口对齐 queue.ts 的 producer（QueueProducerShim 的
// send/sendBatch）与 consumer runner（QueueConsumerRunner 的 start/stop/
// pollOnce），业务代码零改动。
//
// 存储布局（每个队列名 <name> 一组键 + 一个全局注册表）：
//   pigeon:queues                     SET    队列名注册表（runner 发现有哪些队列）
//   pigeon:queue:<name>:ready         LIST   待投递消息 id（RPUSH/LMOVE）
//   pigeon:queue:<name>:processing    LIST   已取出未确认的 id（崩溃恢复：下次轮询挪回 ready）
//   pigeon:queue:<name>:delayed       ZSET   延迟重投：score = available_at 毫秒
//   pigeon:queue:<name>:payload       HASH   id → JSON body
//   pigeon:queue:<name>:attempts      HASH   id → 尝试次数
//
// 投递语义与 DB 版一致（at-least-once）：消息从 ready 取出到 dispatch
// 完成之间进程崩溃，processing 里残留的 id 会在下次 pollOnce 开头被挪回
// ready 重投。到期延迟消息用 Lua 原子搬移（ZRANGEBYSCORE + ZREM + RPUSH），
// 避免多 runner 抢同一批 id 时重复入队。

import type { Redis } from 'ioredis';
import { getRedis } from './redis.ts';
import type {
  MessageBatchShim,
  QueueConsumerRunnerOptions,
  QueueMessageShim,
  QueueSendOptions,
} from './queue.ts';

const QUEUES_KEY = 'pigeon:queues';

const readyKey = (name: string): string => `pigeon:queue:${name}:ready`;
const processingKey = (name: string): string => `pigeon:queue:${name}:processing`;
const delayedKey = (name: string): string => `pigeon:queue:${name}:delayed`;
const payloadKey = (name: string): string => `pigeon:queue:${name}:payload`;
const attemptsKey = (name: string): string => `pigeon:queue:${name}:attempts`;

/** 到期延迟消息原子搬移：ZSET → ready 列表。KEYS=[delayed, ready]，ARGV=[now, limit] */
const PROMOTE_LUA = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local moved = 0
for _, id in ipairs(ids) do
  if redis.call('ZREM', KEYS[1], id) == 1 then
    redis.call('RPUSH', KEYS[2], id)
    moved = moved + 1
  end
end
return moved
`;

/** 消息 id：随机即可，业务侧不依赖有序性 */
function newId(): string {
  return crypto.randomUUID();
}

// ── producer ─────────────────────────────────────────────────────────────────

export class RedisQueueProducer<T = unknown> {
  readonly #redis: Redis;
  readonly #queueName: string;

  constructor(redis: Redis, queueName: string) {
    this.#redis = redis;
    this.#queueName = queueName;
  }

  async send(body: T, _options?: QueueSendOptions): Promise<void> {
    const id = newId();
    const queue = this.#queueName;
    // 注册表 + payload + 入队三步非原子：注册表多发一次 SADD 无害；
    // payload 先于入队写（消费端读不到 payload 的 id 视为脏数据清理）
    await this.#redis
      .multi()
      .sadd(QUEUES_KEY, queue)
      .hset(payloadKey(queue), id, JSON.stringify(body))
      .rpush(readyKey(queue), id)
      .exec();
  }

  /** Workers sendBatch 的消息形状：业务代码只用 { body } */
  async sendBatch(messages: Array<{ body: T }>): Promise<void> {
    for (const message of messages) await this.send(message.body);
  }
}

// ── consumer runner ──────────────────────────────────────────────────────────

export class RedisQueueConsumerRunner {
  readonly #consumer: (batch: MessageBatchShim<unknown>) => Promise<void> | void;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #maxAttempts: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(
    consumer: (batch: MessageBatchShim<unknown>) => Promise<void> | void,
    options: QueueConsumerRunnerOptions = {},
  ) {
    this.#consumer = consumer;
    this.#intervalMs = options.intervalMs ?? 1000;
    this.#batchSize = options.batchSize ?? 10;
    this.#maxAttempts = options.maxAttempts ?? 10;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.pollOnce().catch(error => console.error('[queue-redis] 轮询失败，下一轮重试', error));
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined; }
  }

  /** 手动触发一轮投递（测试与 start 前的即时消费用） */
  async pollOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const redis = await getRedis();
      if (redis === undefined) return;
      const queues = await redis.smembers(QUEUES_KEY);
      for (const queue of queues) {
        await this.#recoverProcessing(redis, queue);
        await this.#promoteDue(redis, queue);
      }
      for (const queue of queues) {
        const ids = await this.#popReady(redis, queue);
        if (ids.length > 0) await this.#dispatch(redis, queue, ids);
      }
    } catch (error) {
      // Redis 断连等故障记日志、下一轮重试（与 DB 版的兜底语义一致）
      console.error('[queue-redis] 轮询失败，下一轮重试', error);
    } finally {
      this.#running = false;
    }
  }

  /** 崩溃恢复：processing 残留 id 挪回 ready（单 runner 假设，见文件头） */
  async #recoverProcessing(redis: Redis, queue: string): Promise<void> {
    while (await redis.llen(processingKey(queue)) > 0) {
      await redis.lmove(processingKey(queue), readyKey(queue), 'LEFT', 'RIGHT');
    }
  }

  /** 到期延迟消息搬入 ready（Lua 原子，循环搬完为止） */
  async #promoteDue(redis: Redis, queue: string): Promise<void> {
    for (;;) {
      const moved = await redis.eval(PROMOTE_LUA, 2, delayedKey(queue), readyKey(queue), Date.now(), this.#batchSize) as number;
      if (!moved) break;
    }
  }

  /** ready → processing 逐条 LMOVE（取出即登记，崩溃可恢复），返回本批 id */
  async #popReady(redis: Redis, queue: string): Promise<string[]> {
    const ids: string[] = [];
    while (ids.length < this.#batchSize) {
      const id = await redis.lmove(readyKey(queue), processingKey(queue), 'LEFT', 'RIGHT');
      if (id === null) break;
      ids.push(id);
    }
    return ids;
  }

  async #dispatch(redis: Redis, queueName: string, ids: string[]): Promise<void> {
    const payloads = await redis.hmget(payloadKey(queueName), ...ids);
    // payload 缺失的 id 是历史脏数据（payload 写入前进程崩溃的窗口），
    // 直接清理不投递
    const deliverable = ids
      .map((id, index) => ({ id, raw: payloads[index] }))
      .filter((entry): entry is { id: string; raw: string } => entry.raw !== null);

    const settled = new Set<string>();
    const pending: Promise<unknown>[] = [];
    const messages: QueueMessageShim<unknown>[] = deliverable.map(({ id, raw }) => ({
      id,
      timestamp: new Date(),
      body: JSON.parse(raw) as unknown,
      ack: () => {
        settled.add(id);
        // 确认 = 从 processing 摘除 + 清 payload/attempts；dispatch 末尾统一
        // await，保证 pollOnce 返回后测试/调用方能立刻看到删除生效
        pending.push(
          redis.lrem(processingKey(queueName), 1, id),
          redis.hdel(payloadKey(queueName), id),
          redis.hdel(attemptsKey(queueName), id),
        );
      },
      retry: (options?: { delaySeconds?: number | undefined }) => {
        settled.add(id);
        const delayMs = (options?.delaySeconds ?? 0) * 1000;
        pending.push(
          redis.hincrby(attemptsKey(queueName), id, 1),
          redis.zadd(delayedKey(queueName), Date.now() + delayMs, id),
          redis.lrem(processingKey(queueName), 1, id),
        );
      },
    }));

    await this.#consumer({ queue: queueName, messages });
    await Promise.all(pending);

    // 既不 ack 也不 retry（异常中断）：保底递增 attempts 并挪回 ready，
    // 与 DB 版"行还在、下次轮询重投"语义一致
    const unsettled = deliverable.filter(({ id }) => !settled.has(id));
    if (unsettled.length > 0) {
      await Promise.all(unsettled.flatMap(({ id }) => [
        redis.hincrby(attemptsKey(queueName), id, 1),
        redis.lrem(processingKey(queueName), 1, id),
        redis.rpush(readyKey(queueName), id),
      ]));
    }

    // 超过最大尝试次数的消息放弃投递（对齐 DB 版：投递后检查再清理）
    const attemptValues = deliverable.length === 0
      ? []
      : await redis.hmget(attemptsKey(queueName), ...deliverable.map(({ id }) => id));
    const over = deliverable
      .map(({ id }, index) => ({ id, attempts: Number(attemptValues[index] ?? 0) }))
      .filter(({ attempts }) => attempts >= this.#maxAttempts);
    for (const { id, attempts } of over) {
      await Promise.all([
        redis.lrem(processingKey(queueName), 1, id),
        redis.lrem(readyKey(queueName), 1, id),
        redis.zrem(delayedKey(queueName), id),
        redis.hdel(payloadKey(queueName), id),
        redis.hdel(attemptsKey(queueName), id),
      ]);
      console.error(`[queue] 放弃消息：queue=${queueName} id=${id} attempts=${attempts} body=${(payloads[deliverable.findIndex(entry => entry.id === id)] ?? '').slice(0, 200)}`);
    }
  }
}

// ── 装配工厂 ─────────────────────────────────────────────────────────────────

export interface RedisQueueSystem {
  /** 构造指定队列的 producer（对齐 QueueProducerShim 的用法） */
  producer<T = unknown>(queueName: string): RedisQueueProducer<T>;
  /** 构造 runner（对齐 QueueConsumerRunner 的构造签名） */
  runner(
    consumer: (batch: MessageBatchShim<unknown>) => Promise<void> | void,
    options?: QueueConsumerRunnerOptions,
  ): RedisQueueConsumerRunner;
}

/**
 * 构造 Redis 队列系统；未启用 Redis 返回 undefined（runtime 回退 DB 表）。
 * d1 参数仅为与 DB 版装配点对齐而保留，Redis 驱动自身不使用。
 */
export async function createRedisQueueSystem(_d1?: unknown): Promise<RedisQueueSystem | undefined> {
  const { isRedisEnabled } = await import('./redis.ts');
  if (!isRedisEnabled()) return undefined;
  const redis = await getRedis();
  if (redis === undefined) return undefined;
  return {
    producer: <T = unknown>(queueName: string) => new RedisQueueProducer<T>(redis, queueName),
    runner: (consumer, options) => new RedisQueueConsumerRunner(consumer, options),
  };
}
