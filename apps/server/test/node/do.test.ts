// Durable Objects shim 冒烟测试：串行互斥、storage 事务回滚、alarm 触发、
// blockConcurrencyWhile、按名单例路由。

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync, type DatabaseSyncLike } from '../../src/node/sqlite-shim.ts';
import {
  DurableObjectStateShim,
  DurableObjectNamespaceShim,
  createDoNamespace,
  ensureDoStorageTable,
  disposeAllDoAlarms,
} from '../../src/node/do.ts';

let db: DatabaseSyncLike;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  ensureDoStorageTable(db);
});
afterEach(() => {
  disposeAllDoAlarms();
  db.close();
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('DurableObjectStorageShim', () => {
  it('put/get 往返（JSON 序列化）与 delete/deleteAll', async () => {
    const state = new DurableObjectStateShim(db, 'inst-1');
    await state.storage.put('job', { phase: 'catalog', cursor: 3 });
    expect(await state.storage.get<{ phase: string; cursor: number }>('job')).toEqual({ phase: 'catalog', cursor: 3 });
    expect(await state.storage.delete('job')).toBe(true);
    expect(await state.storage.get('job')).toBeUndefined();
    await state.storage.put('a', 1);
    await state.storage.put('b', 2);
    await state.storage.deleteAll();
    expect(await state.storage.get('a')).toBeUndefined();
    expect(await state.storage.get('b')).toBeUndefined();
  });

  it('同实例按名共享存储，不同实例隔离', async () => {
    const a = new DurableObjectStateShim(db, 'hash-x');
    const a2 = new DurableObjectStateShim(db, 'hash-x');
    const b = new DurableObjectStateShim(db, 'hash-y');
    await a.storage.put('k', 'v');
    expect(await a2.storage.get('k')).toBe('v');
    expect(await b.storage.get('k')).toBeUndefined();
  });

  it('transaction 内读写可见，异常时回滚', async () => {
    const state = new DurableObjectStateShim(db, 'inst-tx');
    await state.storage.put('job', { phase: 'catalog', retries: 0 });

    await state.storage.transaction(async storage => {
      const job = await storage.get<{ phase: string; retries: number }>('job');
      await storage.put('job', { ...job!, retries: job!.retries + 1 });
      // 事务内读自己刚写的值
      const updated = await storage.get<{ retries: number }>('job');
      expect(updated!.retries).toBe(1);
    });
    expect((await state.storage.get<{ retries: number }>('job'))!.retries).toBe(1);

    await expect(state.storage.transaction(async storage => {
      await storage.put('job', { phase: 'complete', retries: 9 });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // 回滚：job 停留在事务前的值
    expect(await state.storage.get<{ phase: string; retries: number }>('job')).toEqual({ phase: 'catalog', retries: 1 });
  });
});

describe('实例串行化（input gate 等价）', () => {
  it('并发 fetch 实际顺序执行：先到的持有 gate，后到的排队等待', async () => {
    const firstEntered = deferred();
    let releaseFirst!: () => void;
    const releaseGate = new Promise<void>(r => { releaseFirst = r; });
    const order: string[] = [];

    class Gate {
      readonly state: DurableObjectStateShim;
      constructor(state: DurableObjectStateShim) { this.state = state; }
      async fetch(request: Request): Promise<Response> {
        // gate 点：与 derivatives.ts 的 storage.get('__gate__') 同构
        await this.state.storage.get('__gate__');
        const tag = new URL(request.url).searchParams.get('tag')!;
        if (tag === 'slow') {
          firstEntered.resolve();
          await releaseGate;
        }
        order.push(tag);
        return new Response(tag);
      }
    }
    const ns = new DurableObjectNamespaceShim(db, Gate as never, {});
    const stub = ns.get(ns.idFromName('lock'));

    const slow = stub.fetch(new Request('https://do/generate?tag=slow'));
    const fast = stub.fetch(new Request('https://do/generate?tag=fast'));

    // slow 进入 fetch 体并挂起；fast 必须还在队列里（互斥生效）
    await firstEntered.promise;
    await new Promise(r => setTimeout(r, 30));
    expect(order).toEqual([]);

    releaseFirst();
    expect(await slow).toMatchObject({ status: 200 });
    // fast 排到 slow 之后才开始执行
    expect(await fast).toMatchObject({ status: 200 });
    expect(order).toEqual(['slow', 'fast']);
  });
});

describe('按名单例路由', () => {
  it('idFromName 同名同实例、idFromString/idToString 往返', async () => {
    class Counter {
      #count = 0;
      constructor(_state: DurableObjectStateShim, _env: unknown) { void _state; void _env; }
      async fetch(): Promise<Response> {
        return new Response(String(++this.#count));
      }
    }
    const ns = new DurableObjectNamespaceShim(db, Counter as never, {});
    const id = ns.idFromName('tex-abc');
    expect(ns.idToString(id)).toBe('tex-abc');
    expect(ns.idFromString('tex-abc')).toEqual(id);

    const stub = ns.get(id);
    expect(await (await stub.fetch(new Request('https://do/'))).text()).toBe('1');
    // 同名再取：同一实例，计数继续
    expect(await (await ns.get(ns.idFromName('tex-abc')).fetch(new Request('https://do/'))).text()).toBe('2');
    // 不同名：独立实例
    expect(await (await ns.get(ns.idFromName('tex-def')).fetch(new Request('https://do/'))).text()).toBe('1');
  });
});

describe('blockConcurrencyWhile', () => {
  it('fn 期间排队的任务被阻塞，fn 结束后按序执行', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const events: string[] = [];

    const state = new DurableObjectStateShim(db, 'boot-2');
    // official-resources.ts 的用法：fetch 处理器整体包进 blockConcurrencyWhile
    const block = state.blockConcurrencyWhile(async () => {
      await gate;
      events.push('block');
    });
    const fetch1 = state._runExclusive(async () => { events.push('fetch-1'); return 'r1'; });
    const fetch2 = state._runExclusive(async () => { events.push('fetch-2'); return 'r2'; });

    await new Promise(r => setTimeout(r, 20));
    expect(events).toEqual([]);
    release();
    await Promise.all([block, fetch1, fetch2]);
    expect(events).toEqual(['block', 'fetch-1', 'fetch-2']);
  });
});

describe('alarm', () => {
  it('setAlarm 到点触发实例 alarm()，deleteAlarm 取消', async () => {
    vi.useFakeTimers();
    try {
      const fired: number[] = [];
      class Alarmed {
        readonly state: DurableObjectStateShim;
        constructor(state: DurableObjectStateShim) { this.state = state; }
        async fetch(): Promise<Response> {
          await this.state.storage.put('tick', 42);
          await this.state.storage.setAlarm(Date.now() + 1000);
          return new Response('scheduled');
        }
        async alarm(): Promise<void> {
          fired.push(await this.state.storage.get<number>('tick') ?? -1);
        }
      }
      const ns = new DurableObjectNamespaceShim(db, Alarmed as never, {});
      const stub = ns.get(ns.idFromName('alarm-1'));

      // 通过 fetch 安排 alarm
      await stub.fetch(new Request('https://do/schedule'));
      expect(fired).toEqual([]);
      await vi.advanceTimersByTimeAsync(1100);
      expect(fired).toEqual([42]);

      // deleteAlarm 后不再触发
      const state2 = new DurableObjectStateShim(db, 'alarm-2');
      let called = 0;
      class Cancels {
        async alarm(): Promise<void> { called++; }
      }
      const ns2 = new DurableObjectNamespaceShim(db, Cancels as never, {});
      ns2.get(ns2.idFromName('alarm-2'));
      await state2.storage.setAlarm(Date.now() + 500);
      await state2.storage.deleteAlarm();
      await vi.advanceTimersByTimeAsync(1000);
      expect(called).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('createDoNamespace 工厂：transaction 内 put + setAlarm（official-resources 模式）', async () => {
    vi.useFakeTimers();
    try {
      const fired: string[] = [];
      class Updater {
        readonly state: DurableObjectStateShim;
        readonly env: { tag: string };
        constructor(state: DurableObjectStateShim, env: { tag: string }) { this.state = state; this.env = env; }
        async fetch(): Promise<Response> {
          await this.state.storage.transaction(async storage => {
            await storage.put('phase', this.env.tag);
          });
          await this.state.storage.setAlarm(Date.now() + 100);
          return new Response('ok');
        }
        async alarm(): Promise<void> {
          fired.push(await this.state.storage.get<string>('phase') ?? '');
        }
      }
      const ns = createDoNamespace('OFFICIAL_RESOURCES', Updater as never, { tag: 'skins' }, db);
      await ns.get(ns.idFromName('updater')).fetch(new Request('https://do/start'));
      await vi.advanceTimersByTimeAsync(200);
      expect(fired).toEqual(['skins']);
    } finally {
      vi.useRealTimers();
    }
  });
});
