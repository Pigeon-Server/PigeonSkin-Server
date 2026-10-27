import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from '../../src/node/d1/sqlite.ts';
import { runMigrationsForNode } from '../../src/node/migrate.ts';
import { DatabaseSync, type DatabaseSyncLike } from '../../src/node/sqlite-shim.ts';
import { DurableObjectStateShim, ensureDoStorageTable, disposeAllDoAlarms } from '../../src/node/do.ts';
import { CachePublisher } from '../../src/do/cache-publisher.ts';
import { DerivativeGenerator } from '../../src/do/derivatives.ts';
import { TextureSanitizer } from '../../src/do/texture-sanitizer.ts';
import { OfficialResourceUpdater } from '../../src/do/official-resources.ts';
import { newSanitizeJob } from '../../src/services/texture-sanitize.ts';
import { publicCacheRevision, readPublicCache } from '../../src/core/public-cache.ts';
import { backgroundAllowed, noteD1Failure } from '../../src/core/usage-budget.ts';
import { withRequestCache } from '../../src/core/request-cache.ts';
import { invalidateSettingsCache, readSettings } from '../../src/core/settings-reader.ts';
import { writeMany } from '../../src/services/settings.ts';
import { listTaskRuns, writeTaskRun } from '../../src/services/task-runs.ts';
import { listAdminPlayers, listAdminTextures, listAdminUsers } from '../../src/repositories/admin.ts';
import { createDb } from '@pigeon-skin/db';
import type { Bindings } from '../../src/core/env.ts';

let db: SqliteD1;
let storageDb: DatabaseSyncLike;
let values: Map<string, string>;
let env: Bindings;
beforeEach(async () => {
  db = new SqliteD1({ path: ':memory:' });
  await runMigrationsForNode(db);
  storageDb = new DatabaseSync(':memory:');
  ensureDoStorageTable(storageDb);
  values = new Map();
  env = {
    DB: db,
    APP_URL: 'https://local.example',
    ENVIRONMENT: 'production',
    PUBLIC_CACHE: {
      get: async (key: string, type?: string) => values.has(key) ? type === 'json' ? JSON.parse(values.get(key)!) : values.get(key) : null,
      put: async (key: string, value: string) => { values.set(key, value); },
    },
  } as unknown as Bindings;
  invalidateSettingsCache();
});
afterEach(() => { vi.restoreAllMocks(); disposeAllDoAlarms(); db.close(); storageDb.close(); });

describe('公开缓存与配置', () => {
  it('后台无搜索列表按汇总计数，材质筛选保持正确', async () => {
    for (const id of [1, 2]) await db.prepare('INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id, `local${id}@example.invalid`, 'local', 0, 0).run();
    await db.prepare("INSERT INTO players(user_id,name,created_at,updated_at) VALUES(1,'Local',0,0)").run();
    await db.prepare("INSERT INTO textures(hash,kind,model,name,uploader_id,size_bytes,width,height,visibility,created_at,updated_at) VALUES(?,'skin','default','Public',1,1,64,64,'public',0,0),(?,'skin','slim','Private',2,1,64,64,'private',0,0)").bind('a'.repeat(64), 'b'.repeat(64)).run();
    const database = createDb(env.DB);
    const page = { perPage: 24, offset: 0 };
    expect((await listAdminUsers(database, {}, page)).total).toBe(2);
    expect((await listAdminPlayers(database, {}, page)).total).toBe(1);
    expect((await listAdminTextures(database, {}, page)).total).toBe(2);
    expect((await listAdminTextures(database, { visibility: 'private' }, page)).total).toBe(1);
    expect((await listAdminTextures(database, { official: true }, page)).total).toBe(0);
  });

  it('外层发布不能复用旧版本内层缓存', async () => {
    let content = 'old';
    const inner = () => readPublicCache(env, 'manual:inner', ['manual'], async () => content);
    expect(await inner()).toBe('old');
    content = 'new';
    await db.prepare("UPDATE public_cache_versions SET version=version+1 WHERE scope='manual'").run();
    expect(await readPublicCache(env, 'manual:outer', ['manual'], inner)).toBe('new');
  });

  it('构建期间源版本变更时重新构建，再发布对应版本', async () => {
    let calls = 0;
    const seen: unknown[] = [];
    env.CACHE_PUBLISHER = { idFromName: () => 'publisher', get: () => ({ fetch: async (_url: string, init: RequestInit) => { seen.push(JSON.parse(String(init.body))); return new Response(null, { status: 202 }); } }) } as never;
    const result = await readPublicCache(env, 'changing', ['manual'], async () => {
      calls++;
      if (calls === 1) await db.prepare("UPDATE public_cache_versions SET version=version+1 WHERE scope='manual'").run();
      return calls;
    });
    expect(result).toBe(2);
    expect(seen).toMatchObject([{ envelope: { version: await publicCacheRevision(env, ['manual']), data: 2 } }]);
  });

  it('KV 读取失败仍返回权威数据', async () => {
    env.PUBLIC_CACHE!.get = vi.fn(async () => { throw new Error('unavailable'); }) as never;
    expect(await readPublicCache(env, 'failure', ['manual'], async () => 'authority')).toBe('authority');
  });

  it('同请求配置读取合并，独立请求不共享未完成的 I/O', async () => {
    const prepare = vi.spyOn(db, 'prepare');
    await withRequestCache(() => Promise.all([readSettings(env), readSettings(env)]));
    expect(prepare.mock.calls.filter(([query]) => /FROM settings_snapshots/.test(query))).toHaveLength(1);
    prepare.mockClear();
    invalidateSettingsCache();
    await Promise.all([withRequestCache(() => readSettings(env)), withRequestCache(() => readSettings(env))]);
    expect(prepare.mock.calls.filter(([query]) => /FROM settings_snapshots/.test(query))).toHaveLength(2);
  });

  it('并发设置保存只提交一个版本，失败方不能覆盖快照', async () => {
    const results = await Promise.allSettled([
      writeMany(env, [{ key: 'site_name', value: 'One' }], { isSuperAdmin: true }),
      writeMany(env, [{ key: 'site_name', value: 'Two' }], { isSuperAdmin: true }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const row = await db.prepare("SELECT value FROM settings WHERE key='site_name' AND locale=''").first<{ value: string }>();
    const snapshot = await db.prepare("SELECT value FROM settings_snapshots WHERE locale=''").first<{ value: string }>();
    expect(JSON.parse(snapshot!.value).site_name).toBe(row!.value);
  });
});

describe('发布预算和重试', () => {
  function publisher() {
    const state = new DurableObjectStateShim(storageDb, 'publisher');
    return { state, object: new CachePublisher(state as never, env) };
  }
  async function publication(key = 'local', data: unknown = 'value') {
    return new Request('https://publisher/publish', { method: 'POST', body: JSON.stringify({ key, scopes: ['manual'], envelope: { version: await publicCacheRevision(env, ['manual']), publishedAt: Date.now(), data } }) });
  }

  it('发布失败持久保留，退避后 alarm 重试成功', async () => {
    const { state, object } = publisher();
    const put = vi.spyOn(env.PUBLIC_CACHE!, 'put').mockRejectedValueOnce(new Error('offline'));
    await object.fetch(await publication());
    expect((await state.storage.list({ prefix: 'pending:' })).size).toBe(1);
    await object.alarm();
    expect(put).toHaveBeenCalledTimes(1);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 3 * 60_000);
    await object.alarm();
    expect(put).toHaveBeenCalledTimes(2);
    expect((await state.storage.list({ prefix: 'pending:' })).size).toBe(0);
  });

  it('每日发布预算耗尽后不写 KV，alarm 保持在 UTC 次日', async () => {
    const { state, object } = publisher();
    const day = new Date().toISOString().slice(0, 10);
    await state.storage.put('budget', { day, writes: 800 });
    await object.fetch(await publication());
    expect(values.size).toBe(0);
    expect(await state.storage.getAlarm()).toBe(Date.parse(day) + 86_400_000);
    await object.alarm();
    expect(await state.storage.getAlarm()).toBe(Date.parse(day) + 86_400_000);
  });

  it('KV 预算耗尽时保留 sitemap 已安排的较早重建', async () => {
    const { state, object } = publisher();
    const day = new Date().toISOString().slice(0, 10);
    await state.storage.put('budget', { day, writes: 800 });
    await object.fetch(new Request('https://publisher/sitemap/refresh', { method: 'POST' }));
    const sitemapAlarm = await state.storage.getAlarm();
    await object.fetch(await publication());
    expect(sitemapAlarm).not.toBeNull();
    expect(await state.storage.getAlarm()).toBe(sitemapAlarm);
    expect(sitemapAlarm!).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it('源已变更的待发布内容被丢弃', async () => {
    const { state, object } = publisher();
    const request = await publication();
    await db.prepare("UPDATE public_cache_versions SET version=version+1 WHERE scope='manual'").run();
    expect((await object.fetch(request)).status).toBe(409);
    expect(values.size).toBe(0);
    expect((await state.storage.list({ prefix: 'pending:' })).size).toBe(0);
  });

  it('D1 配额错误只使当前请求失败，后续请求仍可进入发布器', async () => {
    const { object } = publisher();
    const request = await publication();
    const prepare = vi.spyOn(db, 'prepare').mockImplementationOnce(() => { throw new Error('D1_ERROR: Your account has exceeded D1 daily row read limit'); });
    expect((await object.fetch(request)).status).toBe(503);
    expect((await object.fetch(new Request('https://publisher/quota', { method: 'POST' }))).status).toBe(204);
    expect(prepare).toHaveBeenCalled();
    const day = new Date().toISOString().slice(0, 10);
    expect(values.has(`d1:circuit:${day}`)).toBe(true);
  });

  it('并发发布等待前一个请求完成并分别写入 KV', async () => {
    const { object } = publisher();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const original = env.PUBLIC_CACHE!.put.bind(env.PUBLIC_CACHE);
    vi.spyOn(env.PUBLIC_CACHE!, 'put').mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args); });
    const firstRequest = await publication('first');
    const secondRequest = await publication('second');
    const first = object.fetch(firstRequest);
    await ready;
    const second = object.fetch(secondRequest);
    release();
    expect((await first).status).toBe(202);
    expect((await second).status).toBe(202);
    expect(values.get('first')).toBeDefined();
    expect(values.get('second')).toBeDefined();
  });

  it('发布缓慢时 sitemap 变更仍立即记录并安排重建', async () => {
    const { state, object } = publisher();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const original = env.PUBLIC_CACHE!.put.bind(env.PUBLIC_CACHE);
    vi.spyOn(env.PUBLIC_CACHE!, 'put').mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args); });
    const publishing = object.fetch(await publication('slow'));
    await ready;
    expect((await object.fetch(new Request('https://publisher/sitemap/refresh', { method: 'POST' }))).status).toBe(202);
    expect(await state.storage.get('sitemap-dirty')).toBe(true);
    expect(await state.storage.get('sitemap-dirty-version')).toBe(1);
    expect(await state.storage.getAlarm()).not.toBeNull();
    release();
    expect((await publishing).status).toBe(202);
  });

  it('发布器长时间忙碌时等待请求超时，完成后仍可继续服务', async () => {
    vi.useFakeTimers();
    try {
      const { object } = publisher();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const original = env.PUBLIC_CACHE!.put.bind(env.PUBLIC_CACHE);
      vi.spyOn(env.PUBLIC_CACHE!, 'put').mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args); });
      const first = object.fetch(await publication('slow'));
      await ready;
      const second = object.fetch(await publication('waiting'));
      await vi.advanceTimersByTimeAsync(25_025);
      expect((await second).status).toBe(503);
      release();
      expect((await first).status).toBe(202);
      expect((await object.fetch(await publication('later'))).status).toBe(202);
    } finally { vi.useRealTimers(); }
  });
});

describe('预算与重计算协调', () => {
  it('首次读取导入旧 D1 历史，此后不再访问业务库', async () => {
    await db.prepare("INSERT INTO task_runs(name,ok,detail,ran_at) VALUES('cleanup',1,'legacy',123)").run();
    const state = new DurableObjectStateShim(storageDb, 'legacy-history');
    const object = new CachePublisher(state as never, env);
    const first = await object.fetch(new Request('https://publisher/task-runs'));
    expect(await first.json()).toMatchObject([{ name: 'cleanup', ok: true, detail: 'legacy', ranAt: 123 }]);
    const prepare = vi.spyOn(db, 'prepare');
    await object.fetch(new Request('https://publisher/task-runs'));
    expect(prepare).not.toHaveBeenCalled();
  });

  it('任务运行历史保留最近50条，读取写入均不访问 D1', async () => {
    const state = new DurableObjectStateShim(storageDb, 'history');
    const object = new CachePublisher(state as never, env);
    env.CACHE_PUBLISHER = { idFromName: () => 'publisher', get: () => ({ fetch: (url: string, init?: RequestInit) => object.fetch(new Request(url, init)) }) } as never;
    await listTaskRuns(env);
    const prepare = vi.spyOn(db, 'prepare');
    for (let index = 0; index < 55; index++) await writeTaskRun(env, 'cleanup', true, String(index), index);
    const rows = await listTaskRuns(env);
    expect(rows).toHaveLength(50);
    expect(rows[0]?.detail).toBe('54');
    expect(rows.at(-1)?.detail).toBe('5');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('净化 alarm 遇到嵌套 D1 配额错误保留游标和重试次数', async () => {
    const state = new DurableObjectStateShim(storageDb, 'sanitize');
    const job = { ...newSanitizeJob(), cursor: 27, retries: 2 };
    await state.storage.put('job', job);
    const prepare = vi.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('D1_ERROR: Your account has exceeded D1 daily row read limit'); });
    const object = new TextureSanitizer(state as never, env);
    await object.alarm();
    expect(await state.storage.get('job')).toEqual(job);
    const calls = prepare.mock.calls.length;
    await object.alarm();
    expect(prepare).toHaveBeenCalledTimes(calls);
    expect(await state.storage.getAlarm()).toBe(Date.parse(new Date().toISOString().slice(0, 10)) + 86_400_000);
  });

  it('官方同步 alarm 遇到 D1 配额错误不写错误记录或推进任务', async () => {
    const state = new DurableObjectStateShim(storageDb, 'official');
    const job = { id: 'local', phase: 'catalog', version: '1.21.4', cursor: 0, added: 0, updated: 0, retries: 1, failed: false };
    await state.storage.put('job', job);
    const object = new OfficialResourceUpdater(state as never, env);
    const target = object as unknown as { advance(job: unknown): Promise<void> };
    vi.spyOn(target, 'advance').mockRejectedValue(new Error('Failed query', { cause: new Error('D1_ERROR: Your account has exceeded D1 daily row read limit') }));
    const prepare = vi.spyOn(db, 'prepare');
    await object.alarm();
    expect(await state.storage.get('job')).toEqual(job);
    expect(prepare).not.toHaveBeenCalled();
    expect(await state.storage.getAlarm()).toBe(Date.parse(new Date().toISOString().slice(0, 10)) + 86_400_000);
  });

  it('实际 D1 日额度错误后后台检查不再查库', async () => {
    await noteD1Failure(env, new Error('D1_ERROR: Your account has exceeded D1 daily row read limit'));
    const prepare = vi.spyOn(db, 'prepare');
    for (let minute = 0; minute < 100; minute++) expect(await backgroundAllowed(env)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('同个衍生图并发请求只访问一次 R2，响应正文可分别消费', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const get = vi.fn(async () => { await gate; return { body: new Uint8Array([1, 2, 3]), size: 3 }; });
    const generator = new DerivativeGenerator({} as never, { ...env, BUCKET: { get } } as never);
    const requests = Array.from({ length: 5 }, () => generator.fetch(new Request(`https://derivative/generate?hash=${'a'.repeat(64)}&kind=avatar-2d-64`)));
    release();
    const responses = await Promise.all(requests);
    expect(get).toHaveBeenCalledTimes(1);
    expect(await Promise.all(responses.map(async response => [...new Uint8Array(await response.arrayBuffer())]))).toEqual(Array.from({ length: 5 }, () => [1, 2, 3]));
  });
});
