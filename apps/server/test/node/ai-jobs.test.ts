// AI 任务队列执行器单测：入队去重、到期认领、失败退避、任务实现。
// 复用 Node 自托管的 SqliteD1 适配器 + 真实 migration。

import { type Bindings } from './../../src/core/env.ts';
import { invalidateSettingsCache } from './../../src/core/settings-reader.ts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SqliteD1 } from '../../src/node/d1/sqlite.ts';
import { runMigrationsForNode } from '../../src/node/migrate.ts';

import { enqueueAiJob, processDueJobs, retryAiJob, cancelAiJob, backfillAiJobs } from '../../src/services/ai-jobs.ts';

const AI = {
  run: async () => {
    return { response: '{"translations": {}}' };
  },
};

/** 可用的翻译输出：渠道正常时的返回值，用来验证渠道恢复后任务能继续跑完 */
const TRANSLATING_AI = {
  run: async () => {
    return { response: '{"translations": {"en": {"name": "Name", "description": "Desc"}}}' };
  },
};

/** Workers AI 免费额度耗尽的原始错误形态（AiError: 4006） */
function quotaError(): Error {
  return Object.assign(
    new Error("4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage."),
    { code: 4006 },
  );
}

function bindings(d1: SqliteD1, ai: unknown = AI): Bindings {
  return { AI: ai, DB: d1 } as unknown as Bindings;
}

afterAll(() => d1.close());

let d1: SqliteD1;
beforeEach(async () => {
  d1 = new SqliteD1({ path: ':memory:' });
  await runMigrationsForNode(d1);
  invalidateSettingsCache();
});

describe('ai jobs queue', () => {
  it('入队同一 (kind, tid) 两次只保留一行并重置', async () => {
    await enqueueAiJob(bindings(d1), 'translate_texture', 1);
    await enqueueAiJob(bindings(d1), 'translate_texture', 1);
    const rows = await d1.prepare('SELECT status, attempts FROM ai_jobs').all<{ status: string; attempts: number }>();
    expect(rows.results!.length).toBe(1);
    expect(rows.results![0]!.status).toBe('pending');
    expect(rows.results![0]!.attempts).toBe(0);
  });

  it('不同 kind 同 tid 是两个任务', async () => {
    await enqueueAiJob(bindings(d1), 'translate_texture', 1);
    await enqueueAiJob(bindings(d1), 'moderate_texture_name', 1);
    const rows = await d1.prepare('SELECT kind FROM ai_jobs').all<{ kind: string }>();
    expect(rows.results!.length).toBe(2);
  });

  it('功能关闭时入队为空操作', async () => {
    expect(await enqueueAiJob(bindings(d1), 'translate_texture', 1, { enabled: false })).toBe(false);
    const rows = await d1.prepare('SELECT * FROM ai_jobs').all();
    expect(rows.results!.length).toBe(0);
  });

  it('processDueJobs 执行成功任务置 done', async () => {
    await enqueueAiJob(bindings(d1), 'translate_texture', 1);
    await processDueJobs(bindings(d1));
    const row = await d1.prepare('SELECT status FROM ai_jobs').first<{ status: string }>();
    expect(row!.status).toBe('done');
  });

  it('材质不存在的任务直接 failed（永久失败不重试）', async () => {
    // 任务实现内部再次核对开关，需要先开启（readSettings 有 isolate 内缓存，写后需失效）
    await d1.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('texture_ai_translation', '', 'true', 0)").run();
    invalidateSettingsCache();
    await enqueueAiJob(bindings(d1), 'translate_texture', 99999);
    await processDueJobs(bindings(d1));
    const row = await d1.prepare('SELECT status, attempts, last_error FROM ai_jobs').first<{ status: string; attempts: number; last_error: string }>();
    expect(row!.status).toBe('failed');
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain('texture deleted');
  });

  it('retry 重置 failed 任务为 pending', async () => {
    await enqueueAiJob(bindings(d1), 'translate_texture', 99999);
    await processDueJobs(bindings(d1));
    const failed = await d1.prepare('SELECT id FROM ai_jobs').first<{ id: number }>();
    expect(await retryAiJob(bindings(d1), failed!.id)).toBe(true);
    const row = await d1.prepare('SELECT status, attempts FROM ai_jobs').first<{ status: string; attempts: number }>();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);
  });

  it('cancel 只能取消 pending 任务', async () => {
    await enqueueAiJob(bindings(d1), 'translate_texture', 1);
    const row = await d1.prepare('SELECT id FROM ai_jobs').first<{ id: number }>();
    expect(await cancelAiJob(bindings(d1), row!.id)).toBe(true);
    const status = await d1.prepare('SELECT status FROM ai_jobs').first<{ status: string }>();
    expect(status!.status).toBe('cancelled');
    expect(await cancelAiJob(bindings(d1), row!.id)).toBe(false);
  });
});

describe('ai jobs provider outage', () => {
  beforeEach(async () => {
    await d1.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('texture_ai_translation', '', 'true', 0)").run();
    invalidateSettingsCache();
  });

  async function seedTextures(count: number): Promise<number[]> {
    const db = createDb(d1 as never);
    const { textures } = await import('@pigeon-skin/db');
    const rows = await db.insert(textures).values(Array.from({ length: count }, (_, index) => ({
      hash: `quota-${index}-${Date.now()}`, kind: 'skin', name: `T${index}`, uploaderId: null, sizeBytes: 1,
      visibility: 'public', width: 64, height: 64, createdAt: index + 1, updatedAt: index + 1,
    }))).returning({ id: textures.id });
    return rows.map((row) => row.id);
  }

  function downWith(error: () => Error) {
    return { run: async () => { throw error(); } };
  }

  async function jobRows(tid: number) {
    return await d1.prepare('SELECT status, attempts, next_run_at, last_error FROM ai_jobs WHERE tid = ?')
      .bind(tid).first<{ status: string; attempts: number; next_run_at: number; last_error: string }>();
  }

  async function aiJobRunRecord() {
    return await d1.prepare("SELECT ok, detail FROM task_runs WHERE name = 'ai_jobs' ORDER BY id DESC")
      .first<{ ok: number; detail: string }>();
  }

  it('渠道配额耗尽：不计失败次数、整队推后，渠道恢复后自动跑完', async () => {
    const [a, b] = await seedTextures(2);
    await enqueueAiJob(bindings(d1), 'translate_texture', a!);
    await enqueueAiJob(bindings(d1), 'translate_texture', b!);

    let calls = 0;
    const down = { run: async () => { calls += 1; throw quotaError(); } };
    const before = Date.now();
    await processDueJobs(bindings(d1, down));

    expect(calls).toBe(2);
    const rows = await d1.prepare('SELECT status, attempts, next_run_at, last_error FROM ai_jobs').all<{ status: string; attempts: number; next_run_at: number; last_error: string }>();
    expect(rows.results!.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.results!.every((r) => r.attempts === 0)).toBe(true);
    expect(rows.results!.every((r) => r.next_run_at >= before + 30 * 60_000)).toBe(true);
    expect(rows.results![0]!.last_error).toContain('AI 渠道不可用（quota）');
    // 渠道停摆在后台「定时任务」页可见，而不是只写日志
    expect(await aiJobRunRecord()).toMatchObject({ ok: 0 });
    expect((await aiJobRunRecord())!.detail).toContain('quota');

    // 队列已整体推后：再触发一次不会继续撞同一个坏渠道
    await processDueJobs(bindings(d1, down));
    expect(calls).toBe(2);

    // 渠道恢复（配额重置 / 换驱动 / 补凭据）：到期后自动跑完，不需要管理员重跑
    await d1.prepare('UPDATE ai_jobs SET next_run_at = 0').run();
    await processDueJobs(bindings(d1, TRANSLATING_AI));
    const done = await d1.prepare('SELECT status FROM ai_jobs').all<{ status: string }>();
    expect(done.results!.every((r) => r.status === 'done')).toBe(true);
  });

  it('任务自身的失败（输出不可用）仍计次数并按退避重排', async () => {
    const [a] = await seedTextures(1);
    await enqueueAiJob(bindings(d1), 'translate_texture', a!);
    await processDueJobs(bindings(d1));
    const row = await jobRows(a!);
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain('no usable translations');
    // 任务级失败不暂停队列，也不写渠道记录
    expect(await aiJobRunRecord()).toBeNull();
  });

  it('鉴权失败同样是渠道级：按 60 分钟推后并留可见记录', async () => {
    const [a] = await seedTextures(1);
    await enqueueAiJob(bindings(d1), 'translate_texture', a!);
    const before = Date.now();
    await processDueJobs(bindings(d1, downWith(() => new Error('anthropic 401 unauthorized'))));
    const row = await jobRows(a!);
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);
    expect(row!.next_run_at).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(row!.last_error).toContain('AI 渠道不可用（auth）');
    expect((await aiJobRunRecord())!.detail).toContain('auth');
  });

  it('暂停只推后到期任务：未来排期与已结束的任务不动', async () => {
    const [due, future, done] = await seedTextures(3);
    await enqueueAiJob(bindings(d1), 'translate_texture', due!);
    await enqueueAiJob(bindings(d1), 'translate_texture', future!);
    await enqueueAiJob(bindings(d1), 'translate_texture', done!);
    const scheduledAt = Date.now() + 7 * 24 * 3600_000;
    await d1.prepare('UPDATE ai_jobs SET next_run_at = ? WHERE tid = ?').bind(scheduledAt, future!).run();
    await d1.prepare("UPDATE ai_jobs SET status = 'done', next_run_at = 0 WHERE tid = ?").bind(done!).run();

    await processDueJobs(bindings(d1, downWith(quotaError)));

    expect((await jobRows(due!))!.next_run_at).toBeGreaterThan(Date.now());
    expect(await jobRows(future!)).toMatchObject({ status: 'pending', next_run_at: scheduledAt });
    expect(await jobRows(done!)).toMatchObject({ status: 'done', next_run_at: 0 });
  });

  it('单个任务超时只推后它自己，不暂停队列', async () => {
    const [a] = await seedTextures(1);
    await enqueueAiJob(bindings(d1), 'translate_texture', a!);
    const timedOut = downWith(() => new Error('AI call timed out'));

    await processDueJobs(bindings(d1, timedOut));
    const first = await jobRows(a!);
    expect(first).toMatchObject({ status: 'pending', attempts: 0 });
    expect(first!.last_error).toContain('AI 渠道不可用（timeout）');
    expect(await aiJobRunRecord()).toBeNull();
  });

  it('同批 ≥2 个任务超时按渠道整体变慢处理：暂停队列并留记录', async () => {
    const [a, b] = await seedTextures(2);
    await enqueueAiJob(bindings(d1), 'translate_texture', a!);
    await enqueueAiJob(bindings(d1), 'translate_texture', b!);
    const timedOut = downWith(() => new Error('AI call timed out'));

    await processDueJobs(bindings(d1, timedOut));
    expect(await jobRows(a!)).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await aiJobRunRecord())!.detail).toContain('timeout');
  });

  it('连续超时按任务失败计次，最终落 failed（不会无限挂起）', async () => {
    const [a] = await seedTextures(1);
    await enqueueAiJob(bindings(d1), 'translate_texture', a!);
    const timedOut = downWith(() => new Error('AI call timed out'));

    await processDueJobs(bindings(d1, timedOut));           // 第一次超时：渠道级，不计次
    expect(await jobRows(a!)).toMatchObject({ status: 'pending', attempts: 0 });
    for (let round = 1; round <= 5; round += 1) {
      await d1.prepare('UPDATE ai_jobs SET next_run_at = 0').run();
      await processDueJobs(bindings(d1, timedOut));
    }
    const settled = await jobRows(a!);
    expect(settled!.status).toBe('failed');
    expect(settled!.attempts).toBe(5);
  });

  it('渠道停摆期间的重复暂停只写一条记录（不刷满后台任务页）', async () => {
    const [a] = await seedTextures(1);
    await enqueueAiJob(bindings(d1), 'translate_texture', a!);
    const down = downWith(quotaError);

    await processDueJobs(bindings(d1, down));
    // 停摆期间每次上传都会触发一次派发：同 kind 在窗口内不重复写记录
    for (let round = 0; round < 3; round += 1) {
      await d1.prepare('UPDATE ai_jobs SET next_run_at = 0').run();
      await processDueJobs(bindings(d1, down));
    }
    const rows = await d1.prepare("SELECT count(*) AS n FROM task_runs WHERE name = 'ai_jobs'").first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });
});

describe('ai jobs backfill', () => {
  it('开关全关时补跑为空', async () => {
    expect(await backfillAiJobs(bindings(d1))).toEqual([]);
  });

  it('只开审核开关时只补审核任务', async () => {
    await d1.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('texture_ai_moderation', '', 'true', 0)").run();
    invalidateSettingsCache();
    const db = createDb(d1 as never);
    const { textures } = await import('@pigeon-skin/db');
    await db.insert(textures).values(
      { hash: `bf-solo-${Date.now()}`, kind: 'skin', name: 'S', uploaderId: null, sizeBytes: 1, visibility: 'public', width: 64, height: 64, createdAt: 1, updatedAt: 1 },
    );
    const results = await backfillAiJobs(bindings(d1));
    expect(results.map((r) => r.kind).sort()).toEqual(['moderate_texture_description', 'moderate_texture_name']);
    const rows = await d1.prepare('SELECT kind FROM ai_jobs').all<{ kind: string }>();
    expect(rows.results!.length).toBe(2);
  });

  it('为存量材质补齐缺失任务，已有任务不重置', async () => {
    await d1.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('texture_ai_translation', '', 'true', 0), ('texture_ai_moderation', '', 'true', 0)").run();
    invalidateSettingsCache();
    const db = createDb(d1 as never);
    const { textures } = await import('@pigeon-skin/db');
    const base = Date.now();
    // 材质 A 名称为空：翻译任务执行时直接成功置 done，验证补跑不重置它
    await db.insert(textures).values([
      { hash: `bf-a-${base}`, kind: 'skin', name: '', uploaderId: null, sizeBytes: 1, visibility: 'public', width: 64, height: 64, createdAt: 1, updatedAt: 1 },
      { hash: `bf-b-${base}`, kind: 'skin', name: 'B', uploaderId: null, sizeBytes: 1, visibility: 'public', width: 64, height: 64, createdAt: 2, updatedAt: 2 },
    ]);
    // 材质 A 已有（已完成的）翻译任务，补跑不得重置它
    await enqueueAiJob(bindings(d1), 'translate_texture', 1);
    await processDueJobs(bindings(d1));

    const results = await backfillAiJobs(bindings(d1));
    const byKind = new Map(results.map((r) => [r.kind, r.queued]));
    expect(byKind.get('moderate_texture_name')).toBe(2);
    expect(byKind.get('moderate_texture_description')).toBe(2);
    // 材质 B 补了翻译任务，材质 A 的已完成任务保持 done
    expect(byKind.get('translate_texture')).toBe(1);
    const rows = await d1.prepare("SELECT tid, status FROM ai_jobs WHERE kind = 'translate_texture' ORDER BY tid").all<{ tid: number; status: string }>();
    expect(rows.results!.length).toBe(2);
    expect(rows.results![0]).toEqual({ tid: 1, status: 'done' });
    expect(rows.results![1]).toEqual({ tid: 2, status: 'pending' });
    // 再跑一次：无新增
    const again = await backfillAiJobs(bindings(d1));
    expect(again.every((r) => r.queued === 0)).toBe(true);
  });
});

// ── 译文覆盖查询（P0 回归：join 别名 SQL 必须真实可执行）────────────────────

import * as texturesRepo from '../../src/repositories/textures.ts';
import { createDb } from '@pigeon-skin/db';

describe('texture translation overlay query', () => {
  it('带 locale 的列表与详情在有/无译文时都执行成功且名称正确', async () => {
    const db = createDb(d1 as never);
    // 建测试纹理（hash 不重复即可）
    const [texture] = await db.insert((await import('@pigeon-skin/db')).textures)
      .values({ hash: `t-${Date.now()}`, kind: 'skin', name: 'Original Name', uploaderId: null, sizeBytes: 1, visibility: 'public', width: 64, height: 64, createdAt: 1, updatedAt: 1 })
      .returning({ id: (await import('@pigeon-skin/db')).textures.id });
    // 无译文：查询成功，回退原文
    const viewerless = { viewer: null, isAdmin: false };
    const empty = await texturesRepo.listTextures(db, { sort: 'created', ...viewerless }, { perPage: 10, offset: 0, page: 1 }, 'ja_JP');
    expect(empty.items.find(i => i.id === texture!.id)?.name).toBe('Original Name');
    // 写入 ja_JP 译文后：名称被覆盖
    await db.insert((await import('@pigeon-skin/db')).textureTranslations)
      .values({ tid: texture!.id, locale: 'ja_JP', name: '翻訳名', description: '', createdAt: 1, updatedAt: 1 });
    const translated = await texturesRepo.listTextures(db, { sort: 'created', ...viewerless }, { perPage: 10, offset: 0, page: 1 }, 'ja_JP');
    expect(translated.items.find(i => i.id === texture!.id)?.name).toBe('翻訳名');
    // 详情同样生效
    const row = await texturesRepo.findTextureById(db, texture!.id, 'ja_JP');
    expect(row?.name).toBe('翻訳名');
    // 其他 locale 仍回退原文
    const other = await texturesRepo.findTextureById(db, texture!.id, 'zh_CN');
    expect(other?.name).toBe('Original Name');
    // 不带 locale 时 join 恒假条件同样可执行
    const plain = await texturesRepo.listTextures(db, { sort: 'created', ...viewerless }, { perPage: 10, offset: 0, page: 1 });
    expect(plain.items.find(i => i.id === texture!.id)?.name).toBe('Original Name');
  });
});
