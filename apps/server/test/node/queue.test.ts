// 队列适配器测试：send/sendBatch → 轮询消费 → ack；retry 延迟重投；
// 超限放弃；生命周期。

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { SqliteD1 } from '../../src/node/d1/sqlite.ts';
import {
  QueueProducerShim, QueueConsumerRunner, ensureJobsTable,
  type MessageBatchShim,
} from '../../src/node/queue.ts';

let d1: SqliteD1;
beforeEach(() => {
  d1 = new SqliteD1({ path: ':memory:' });
  ensureJobsTable(d1);
});
afterEach(() => {
  d1.close();
});

describe('QueueProducerShim / QueueConsumerRunner', () => {
  it('send → 消费 → ack：消息删除，不再重投', async () => {
    const producer = new QueueProducerShim<{ broadcastId: string; title: string }>(d1, 'pigeon-email');
    await producer.send({ broadcastId: 'b1', title: '公告' }, { contentType: 'json' });
    await producer.sendBatch([{ body: { broadcastId: 'b2', title: '第二条' } }]);

    const seen: MessageBatchShim<unknown>[] = [];
    const runner = new QueueConsumerRunner(d1, async batch => {
      seen.push(batch);
      for (const message of batch.messages) message.ack();
    }, { intervalMs: 10 });

    await runner.pollOnce();
    await runner.pollOnce();
    // 同一队列的两条消息合成一个 batch 一次投递；ack 后第二轮无消息
    expect(seen).toHaveLength(1);
    expect(seen[0]!.queue).toBe('pigeon-email');
    const bodies = seen.flatMap(batch => batch.messages.map(message => message.body));
    expect(bodies).toEqual([
      { broadcastId: 'b1', title: '公告' },
      { broadcastId: 'b2', title: '第二条' },
    ]);

    const remaining = (await d1.prepare('SELECT id FROM node_jobs').all()).results ?? [];
    expect(remaining).toHaveLength(0);
  });

  it('retry({ delaySeconds })：attempts+1、available_at 推迟，延迟后重投', async () => {
    vi.useFakeTimers();
    try {
      const producer = new QueueProducerShim<{ engine: string }>(d1, 'pigeon-search');
      await producer.send({ engine: 'bing' });

      let deliveries = 0;
      const runner = new QueueConsumerRunner(d1, async batch => {
        deliveries++;
        for (const message of batch.messages) message.retry({ delaySeconds: 300 });
      }, { intervalMs: 10 });

      await runner.pollOnce();
      expect(deliveries).toBe(1);
      const row = (await d1.prepare('SELECT attempts, available_at FROM node_jobs').all<{ attempts: number; available_at: number }>()).results![0]!;
      expect(row.attempts).toBe(1);
      expect(row.available_at).toBe(Date.now() + 300_000);

      // 延迟未到：不投
      await vi.advanceTimersByTimeAsync(299_000);
      await runner.pollOnce();
      expect(deliveries).toBe(1);

      // 延迟已过：重投
      await vi.advanceTimersByTimeAsync(2_000);
      await runner.pollOnce();
      expect(deliveries).toBe(2);
      expect((await d1.prepare('SELECT attempts FROM node_jobs').all<{ attempts: number }>()).results![0]!.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超过最大尝试次数后放弃并 console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const producer = new QueueProducerShim(d1, 'q');
      await producer.send({ payload: true });

      // maxAttempts=2：第一轮 retry，第二轮直接放弃
      let deliveries = 0;
      const runner = new QueueConsumerRunner(d1, async batch => {
        deliveries++;
        for (const message of batch.messages) message.retry();
      }, { intervalMs: 10, maxAttempts: 2 });

      await runner.pollOnce(); // attempts 0→1，消息保留
      await runner.pollOnce(); // attempts 1→2，随后被放弃删除
      expect(deliveries).toBe(2);
      expect(((await d1.prepare('SELECT id FROM node_jobs').all()).results ?? [])).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]![0]).toContain('放弃消息');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('start/stop 生命周期：start 后按间隔自动轮询', async () => {
    vi.useFakeTimers();
    try {
      const producer = new QueueProducerShim(d1, 'q');
      let deliveries = 0;
      const runner = new QueueConsumerRunner(d1, async batch => {
        for (const message of batch.messages) message.ack();
        deliveries += batch.messages.length;
      }, { intervalMs: 50 });

      runner.start();
      await producer.send({ n: 1 });
      await vi.advanceTimersByTimeAsync(120);
      expect(deliveries).toBe(1);
      runner.stop();
      await producer.send({ n: 2 });
      await vi.advanceTimersByTimeAsync(200);
      // stop 后不再消费
      expect(deliveries).toBe(1);
      expect(((await d1.prepare('SELECT id FROM node_jobs').all()).results ?? [])).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('按 queue 分组构造 batch，批次形状对齐 MessageBatch', async () => {
    const email = new QueueProducerShim(d1, 'email');
    const search = new QueueProducerShim(d1, 'search');
    await email.send({ kind: 'mail' });
    await search.send({ kind: 'search' });

    const queues: string[][] = [];
    const runner = new QueueConsumerRunner(d1, async batch => {
      queues.push(batch.messages.map(message => `${batch.queue}:${JSON.stringify(message.body)}`));
      for (const message of batch.messages) message.ack();
    }, { intervalMs: 10 });
    await runner.pollOnce();

    // 两个队列各自成 batch
    expect(queues.flat().sort()).toEqual(['email:{"kind":"mail"}', 'search:{"kind":"search"}']);
  });
});
