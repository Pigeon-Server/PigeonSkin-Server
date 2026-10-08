// AI 任务队列执行器单测：入队去重、到期认领、失败退避、任务实现。
// 复用 Node 自托管的 SqliteD1 适配器 + 真实 migration。

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SqliteD1 } from '../../src/node/d1/sqlite.ts';
import { runMigrationsForNode } from '../../src/node/migrate.ts';
import { invalidateSettingsCache } from '../../src/lib.ts';
import { enqueueAiJob, processDueJobs, retryAiJob, cancelAiJob } from '../../src/services/ai-jobs.ts';
import type { Bindings } from '../../src/env.ts';

const AI = {
  run: async () => {
    return { response: '{"translations": {}}' };
  },
};

function bindings(d1: SqliteD1): Bindings {
  return { AI, DB: d1 } as unknown as Bindings;
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
