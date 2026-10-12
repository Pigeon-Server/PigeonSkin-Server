// 整点任务的健壮性：部署配置非法时不静默停摆，D1 瞬态错误不丢运行记录。
// 复用 Node 自托管的 SqliteD1 适配器 + 真实 migration。

import { type Bindings } from './../../src/core/env.ts';
import { invalidateSettingsCache } from './../../src/core/settings-reader.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from '../../src/node/d1/sqlite.ts';
import { runMigrationsForNode } from '../../src/node/migrate.ts';

import { runScheduledTasks } from '../../src/tasks.ts';

// 搜索提交的派发要站点地址：配置非法时必须真的不被调用（只看 task_runs 里没有
// search_submissions 行是恒真断言，那个名字根本不会被写入）
const { dispatchSpy } = vi.hoisted(() => ({ dispatchSpy: vi.fn(async () => {}) }));
vi.mock('../../src/services/search-submissions.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/search-submissions.ts')>()),
  dispatchSearchSubmissions: dispatchSpy,
}));

let d1: SqliteD1;
beforeEach(async () => {
  d1 = new SqliteD1({ path: ':memory:' });
  await runMigrationsForNode(d1);
  invalidateSettingsCache();
  dispatchSpy.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  d1.close();
});

/** 收集 waitUntil 的 promise，测试里 await 它们等后台任务真正跑完 */
function executionCtx() {
  const waited: Array<Promise<unknown>> = [];
  return { ctx: { waitUntil: (promise: Promise<unknown>) => { waited.push(promise); } }, settle: () => Promise.all(waited) };
}

function env(overrides: Record<string, unknown> = {}): Bindings {
  return {
    DB: d1,
    APP_URL: 'https://skin.example.com',
    ENVIRONMENT: 'production',
    OFFICIAL_CATALOG_ENABLED: 'false',
    ...overrides,
  } as unknown as Bindings;
}

/** 让前 times 次 task_runs 写入抛错，并统计写入尝试次数。
 *  适配器用 #私有字段存连接，方法必须绑回原对象调用，否则 this 是 Proxy 会直接抛错。 */
function dbFailingTaskRunWrite(db: SqliteD1, message: string, times = 1) {
  let remaining = times;
  const counter = { inserts: 0 };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (/INSERT INTO task_runs/.test(sql)) {
            counter.inserts += 1;
            if (remaining > 0) {
              remaining -= 1;
              throw new Error(message);
            }
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Bindings['DB'];
  return { db: proxy, counter };
}

const TRANSIENT_D1_ERROR = 'D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = test';

async function taskRuns(): Promise<Array<{ name: string; ok: number; detail: string }>> {
  const rows = await d1.prepare('SELECT name, ok, detail FROM task_runs ORDER BY id').all<{ name: string; ok: number; detail: string }>();
  return rows.results!;
}

describe('runScheduledTasks 配置非法', () => {
  it('站点地址非法：记录可见的失败记录，清理与官方资源同步照常执行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, settle } = executionCtx();
    await runScheduledTasks(undefined, env({ APP_URL: 'http://skin.example.com' }), ctx);
    await settle();

    const runs = await taskRuns();
    const configuration = runs.find((run) => run.name === 'configuration');
    expect(configuration).toMatchObject({ ok: 0 });
    expect(configuration!.detail).toContain('APP_URL 必须是 https');
    // 只依赖 DB/R2/DO 的任务不因为一个坏地址停摆
    expect(runs.find((run) => run.name === 'cleanup')).toMatchObject({ ok: 1 });
    expect(runs.find((run) => run.name === 'official_resources')).toMatchObject({ ok: 1 });
    // 搜索提交要拼站点地址：真的没被调用，不拿错误地址去污染搜索引擎索引
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((call) => String(call[0]).includes('部署配置非法'))).toBe(true);
  });

  it('配置正常时不写 configuration 记录，只记录常规任务', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, settle } = executionCtx();
    await runScheduledTasks(undefined, env(), ctx);
    await settle();

    const runs = await taskRuns();
    expect(runs.map((run) => run.name).sort()).toEqual(['cleanup', 'official_resources']);
    expect(runs.every((run) => run.ok === 1)).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('task_runs 写入健壮性', () => {
  it('D1 瞬态内部错误重试一次，运行记录不丢', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, counter } = dbFailingTaskRunWrite(d1, TRANSIENT_D1_ERROR);
    const { ctx, settle } = executionCtx();
    await runScheduledTasks(undefined, env({ DB: db }), ctx);
    await settle();

    const runs = await taskRuns();
    expect(runs.find((run) => run.name === 'cleanup')).toMatchObject({ ok: 1 });
    expect(runs.find((run) => run.name === 'official_resources')).toMatchObject({ ok: 1 });
    // 两个任务各写一次 + 被重试的那一次
    expect(counter.inserts).toBe(3);
    // 运行记录没丢也没有报错（sitemap bump 在 Node 测试环境无 caches 全局，与本次改动无关）
    expect(error.mock.calls.filter((call) => String(call[0]).includes('task_runs'))).toEqual([]);
  });

  it('非瞬态错误不重试：直接记日志，计数不翻倍', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, counter } = dbFailingTaskRunWrite(d1, 'SQLITE_ERROR: no such table: task_runs');
    const { ctx, settle } = executionCtx();
    await runScheduledTasks(undefined, env({ DB: db }), ctx);
    await settle();

    // 两个任务各写一次，失败的那个不重试 → 只有一行记录
    expect(counter.inserts).toBe(2);
    expect((await taskRuns()).length).toBe(1);
    expect(error.mock.calls.some((call) => String(call[0]).includes('task_runs 记录失败'))).toBe(true);
  });
});
