import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import type { Bindings } from '../src/core/env.ts';
import { runMigrations } from './setup.ts';
import { publicCacheRevision } from '../src/core/public-cache.ts';
import { CachePublisher } from '../src/do/cache-publisher.ts';
import { listTaskRuns, writeTaskRun } from '../src/services/task-runs.ts';

beforeAll(runMigrations);

it('依赖失败后同一发布器仍能处理后续请求', async () => {
  await env.DB.prepare('DROP TABLE task_runs').run();
  const namespace = (env as Bindings).CACHE_PUBLISHER!;
  const publisher = namespace.get(namespace.idFromName('failure-test'));
  expect((await publisher.fetch('https://publisher/task-runs')).status).toBe(503);
  expect((await publisher.fetch('https://publisher/quota', { method: 'POST' })).status).toBe(204);
});

it('同一发布器并发请求在各自上下文内完成', async () => {
  const namespace = (env as Bindings).CACHE_PUBLISHER!;
  const publisher = namespace.get(namespace.idFromName('concurrency-test'));
  const version = await publicCacheRevision(env as Bindings, ['manual']);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => publisher.fetch('https://publisher/publish', {
    method: 'POST',
    body: JSON.stringify({ key: `concurrency:${index}`, scopes: ['manual'], envelope: { version, publishedAt: Date.now(), data: index } }),
  })));
  expect(results.map(response => response.status)).toEqual(Array(8).fill(202));
});

it('sitemap 构建期间的新变更不会被 KV 预算的次日调度覆盖', async () => {
  const namespace = (env as Bindings).CACHE_PUBLISHER!;
  const publisher = namespace.get(namespace.idFromName('sitemap-during-build'));
  await runInDurableObject(publisher, async (_instance, state) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const bucket = new Proxy(env.BUCKET, { get(target, name) {
      if (name === 'put') return async (key: string, ...args: unknown[]) => {
        if (key === 'seo/sitemap/manifest.json') { entered(); await gate; }
        return (target.put as (...values: unknown[]) => Promise<unknown>).call(target, key, ...args);
      };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const object = new CachePublisher(state, { ...env, BUCKET: bucket } as Bindings);
    await state.storage.put({ 'sitemap-dirty': true, 'sitemap-dirty-version': 1, budget: { day: new Date().toISOString().slice(0, 10), writes: 800 } });
    const building = object.alarm();
    await ready;
    const publicPublisher = namespace.get(namespace.idFromName('public-cache'));
    const version = await publicCacheRevision(env as Bindings, ['manual']);
    const cacheResponse = await publicPublisher.fetch('https://publisher/publish', { method: 'POST', body: JSON.stringify({ key: 'independent-cache', scopes: ['manual'], envelope: { version, publishedAt: Date.now(), data: 'value' } }) });
    expect(cacheResponse.status).toBe(202);
    await writeTaskRun(env as Bindings, 'isolation-test', true, 'completed', Date.now());
    expect((await listTaskRuns(env as Bindings)).some(item => item.name === 'isolation-test')).toBe(true);
    expect((await object.fetch(new Request('https://publisher/sitemap/refresh', { method: 'POST' }))).status).toBe(202);
    release();
    await building;
    expect(await state.storage.get('sitemap-dirty')).toBe(true);
    expect(await state.storage.get<number>('sitemap-dirty-version')).toBe(2);
    expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 300_000);
  });
});
