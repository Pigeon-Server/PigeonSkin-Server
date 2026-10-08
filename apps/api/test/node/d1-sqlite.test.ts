// D1 适配器冒烟测试：在真实 node:sqlite 上验证 D1 形状接口与业务
// SQL 的关键模式（batch 事务、RETURNING、INSERT OR IGNORE、changes()
// 守卫语义、settings upsert）。

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { SqliteD1 } from '../../src/node/d1/sqlite.ts';
import { rewriteSql } from '../../src/node/d1/rewrite.ts';
import { runMigrationsForNode } from '../../src/node/migrate.ts';

describe('rewriteSql（sqlite 目标）', () => {
  it('原样透传并给出全 value 槽位', () => {
    const result = rewriteSql("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND model IS ?", 'sqlite');
    expect(result.sql).toBe("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND model IS ?");
    expect(result.plan).toEqual([{ kind: 'value' }, { kind: 'value' }]);
    expect(result.emulateInsertReturning).toBe(false);
  });

  it('字符串字面量与注释里的 ? 不计入槽位', () => {
    const result = rewriteSql("SELECT '?' AS a -- comment ?\n WHERE x = ?", 'sqlite');
    expect(result.plan).toEqual([{ kind: 'value' }]);
  });
});

describe('SqliteD1', () => {
  let d1: SqliteD1;
  beforeEach(async () => {
    d1 = new SqliteD1({ path: ':memory:' });
    await runMigrationsForNode(d1);
  });
  afterAll(() => d1.close());

  it('first/all/run 的 D1 形状', async () => {
    const inserted = await d1.prepare("INSERT INTO users (email,nickname,password_hash,created_at,updated_at) VALUES (?,'n','',1,1) RETURNING id").bind('a@x.com').first<{ id: number }>();
    expect(inserted!.id).toBeGreaterThan(0);
    const row = await d1.prepare('SELECT id, email FROM users WHERE id = ?').bind(inserted!.id).first<{ id: number; email: string }>();
    expect(row!.email).toBe('a@x.com');
    const run = await d1.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind('nn', inserted!.id).run();
    expect(run.meta.changes).toBe(1);
  });

  it('batch 原子性：失败回滚', async () => {
    await d1.prepare("INSERT INTO users (email,nickname,password_hash,created_at,updated_at) VALUES (?,'n','',1,1) RETURNING id").bind('batch@x.com').run();
    await expect(d1.batch([
      d1.prepare("UPDATE users SET nickname='x' WHERE email='batch@x.com'"),
      d1.prepare("INSERT INTO users (email,nickname,password_hash,created_at,updated_at) VALUES ('batch@x.com','dup','',1,1)"),
    ])).rejects.toThrow();
    const row = await d1.prepare("SELECT nickname FROM users WHERE email='batch@x.com'").first<{ nickname: string }>();
    expect(row!.nickname).toBe('n');
  });

  it('changes() 守卫语义：扣分失败时 INSERT SELECT 不建行', async () => {
    await d1.prepare("INSERT INTO users (email,score,password_hash,created_at,updated_at) VALUES ('poor@x.com',5,'',1,1)").run();
    const results = await d1.batch([
      d1.prepare('UPDATE users SET score=score-? WHERE id IN (SELECT id FROM users WHERE email=?) AND score>=?').bind(100, 'poor@x.com', 100),
      d1.prepare('INSERT INTO textures(hash,kind,name,size_bytes,visibility,width,height,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()>0 RETURNING id')
        .bind('h', 'skin', 't', 1, 'public', 64, 32, 1, 1),
    ]);
    expect(results[0]!.meta.changes).toBe(0);
    expect(results[1]!.results ?? []).toEqual([]);
  });

  it('INSERT OR IGNORE 与 ON CONFLICT DO UPDATE', async () => {
    await d1.prepare("INSERT INTO settings (key,locale,value,updated_at) VALUES ('k','','v1',1) ON CONFLICT(key, locale) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run();
    await d1.prepare("INSERT INTO settings (key,locale,value,updated_at) VALUES ('k','','v2',2) ON CONFLICT(key, locale) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run();
    const row = await d1.prepare("SELECT value FROM settings WHERE key='k' AND locale=''").first<{ value: string }>();
    expect(row!.value).toBe('v2');
    await d1.prepare("INSERT OR IGNORE INTO settings (key,locale,value,updated_at) VALUES ('k','','ignored',3)").run();
    const row2 = await d1.prepare("SELECT value FROM settings WHERE key='k' AND locale=''").first<{ value: string }>();
    expect(row2!.value).toBe('v2');
  });

  it('raw 的列名形态', async () => {
    await d1.prepare("INSERT INTO users (email,nickname,password_hash,created_at,updated_at) VALUES (?,'n','',1,1)").bind('raw@x.com').run();
    const [names, ...rows] = await d1.prepare('SELECT id, email FROM users WHERE email = ?').bind('raw@x.com').raw({ columnNames: true });
    expect(names).toEqual(['id', 'email']);
    expect((rows[0] as unknown[])[1]).toBe('raw@x.com');
  });
});
