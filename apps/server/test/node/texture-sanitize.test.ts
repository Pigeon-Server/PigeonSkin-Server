// 存量材质净化（services/texture-sanitize.ts 的 sanitizeBatch）。
//
// 在 Node 环境跑：D1 用 node:sqlite 适配器、R2 用文件系统适配器，都是本仓库
// 已有的 Node 自托管实现，能完整覆盖「读对象 → 重编码 → 写新对象 → 删旧对象」
// 这条链路。workerd 测试池的隔离存储会在 suite 结束时比对 R2 后端文件，
// 中途中止/新增对象会误报 "Isolated storage failed"，因此这类用例放这里。

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng, inspectPng, sha256Hex, withTextChunk } from '@pigeon-skin/minecraft';
import { FileSystemR2Bucket } from '../../src/node/r2-fs.ts';
import { SqliteD1 } from '../../src/node/d1/sqlite.ts';
import { sanitizeBatch, newSanitizeJob } from '../../src/services/texture-sanitize.ts';
import type { Bindings } from '../../src/core/env.ts';

let dir: string;
let bucket: FileSystemR2Bucket;
let d1: SqliteD1;
let env: Bindings;

/** 建最小 schema（只包含净化路径用到的表与列）。 */
async function createSchema(db: { exec(q: string): Promise<unknown> }) {
  await db.exec(`
    CREATE TABLE textures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      model TEXT,
      name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sanitized INTEGER NOT NULL DEFAULT 0
    );
  `);
}

async function seed(hash: string, name: string, sanitized = 0): Promise<number> {
  const now = Date.now();
  const row = await d1.prepare(`INSERT INTO textures (hash, kind, model, name, size_bytes, width, height, created_at, updated_at, sanitized)
    VALUES (?, 'skin', 'default', ?, 1, 2, 2, ?, ?, ?) RETURNING id`)
    .bind(hash, name, now, now, sanitized).first<{ id: number }>();
  return row!.id;
}

async function textureRow(id: number): Promise<{ hash: string; sanitized: number }> {
  return (await d1.prepare('SELECT hash, sanitized FROM textures WHERE id = ?').bind(id).first<{ hash: string; sanitized: number }>())!;
}

async function drain(): Promise<ReturnType<typeof newSanitizeJob>> {
  const job = newSanitizeJob();
  for (let i = 0; i < 20; i++) if (await sanitizeBatch(env, job)) break;
  return job;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pigeon-sanitize-'));
  bucket = new FileSystemR2Bucket({ root: join(dir, 'objects') });
  const dbPath = join(dir, 'test.sqlite');
  d1 = new SqliteD1({ path: dbPath });
  await createSchema(d1);
  env = {
    DB: d1,
    BUCKET: bucket,
    APP_URL: 'http://localhost',
  } as unknown as Bindings;
});

afterEach(async () => {
  bucket.close();
  await rm(dir, { recursive: true, force: true });
});

describe('存量材质净化', () => {
  it('strips metadata from a dirty texture and rewrites its hash', async () => {
    const clean = await encodePng(2, 2, new Uint8Array(2 * 2 * 4).fill(200)) as Uint8Array<ArrayBuffer>;
    const dirty = withTextChunk(clean, 'Author', 'someone') as Uint8Array<ArrayBuffer>;
    const oldHash = await sha256Hex(dirty);
    await bucket.put(`textures/${oldHash}.png`, dirty);
    const id = await seed(oldHash, 'dirty-skin');

    const job = await drain();
    expect(job.changed).toBe(1);

    const row = await textureRow(id);
    expect(row.sanitized).toBe(1);
    expect(row.hash).not.toBe(oldHash);
    // 新对象是干净 PNG：只剩结构块
    const fresh = await bucket.get(`textures/${row.hash}.png`);
    const inspection = inspectPng(new Uint8Array(await fresh!.arrayBuffer()));
    expect(inspection.ok && inspection.info.chunkTypes).toEqual(['IHDR', 'IDAT', 'IEND']);
    // 旧对象已回收
    expect(await bucket.get(`textures/${oldHash}.png`)).toBeNull();
  });

  it('keeps an already-clean texture byte-identical and only marks it', async () => {
    const clean = await encodePng(2, 2, new Uint8Array(2 * 2 * 4).fill(90)) as Uint8Array<ArrayBuffer>;
    const hash = await sha256Hex(clean);
    await bucket.put(`textures/${hash}.png`, clean);
    const id = await seed(hash, 'clean-skin');

    await drain();

    const row = await textureRow(id);
    expect(row).toMatchObject({ hash, sanitized: 1 });
    expect(await bucket.get(`textures/${hash}.png`)).not.toBeNull();
  });

  it('skips rows whose object is missing instead of stalling the queue', async () => {
    const id = await seed('e'.repeat(64), 'missing-object');
    const job = await drain();
    expect(job.done).toBe(true);
    expect((await textureRow(id)).sanitized).toBe(1);
  });

  it('keeps the old object when another row still references the same hash', async () => {
    const clean = await encodePng(2, 2, new Uint8Array(2 * 2 * 4).fill(30)) as Uint8Array<ArrayBuffer>;
    const dirty = withTextChunk(clean, 'Author', 'dup') as Uint8Array<ArrayBuffer>;
    const oldHash = await sha256Hex(dirty);
    await bucket.put(`textures/${oldHash}.png`, dirty);
    const first = await seed(oldHash, 'dup-one');
    const second = await seed(oldHash, 'dup-two');

    await drain();

    const { results: rows = [] } = await d1.prepare('SELECT id, hash, sanitized FROM textures WHERE id IN (?, ?) ORDER BY id').bind(first, second).all<{ id: number; hash: string; sanitized: number }>();
    expect(rows.every(r => r.sanitized === 1)).toBe(true);
    // 两行收敛到同一个新 hash，旧对象此时已无引用，可以删
    expect(new Set(rows.map(r => r.hash)).size).toBe(1);
    expect(await bucket.get(`textures/${oldHash}.png`)).toBeNull();
  });

  it('only processes rows after the stored cursor', async () => {
    const clean = await encodePng(2, 2, new Uint8Array(2 * 2 * 4).fill(11)) as Uint8Array<ArrayBuffer>;
    const hash = await sha256Hex(clean);
    await bucket.put(`textures/${hash}.png`, clean);
    const first = await seed(hash, 'cursor-first');
    const later = await seed(hash, 'cursor-later');

    // 游标停在 first 之后：这一轮只处理 later
    const job = { ...newSanitizeJob(), cursor: first };
    await sanitizeBatch(env, job);
    const { results: rows = [] } = await d1.prepare('SELECT id, sanitized FROM textures WHERE id IN (?, ?) ORDER BY id').bind(first, later).all<{ id: number; sanitized: number }>();
    expect(rows[0]!.sanitized).toBe(0);
    expect(rows[1]!.sanitized).toBe(1);
  });
});
