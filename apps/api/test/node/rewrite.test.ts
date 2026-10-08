// rewriteSql 三方言目标的纯函数单测。
// 第一轮审查（P1-3）发现的 MySQL 缺陷（MAX 标量、ORDER BY key、RETURNING 形态）
// 全部落在 postgres/mysql 分支的测试盲区——这里把实测过的语句固化为回归用例。

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { rewriteSql } from '../../src/node/d1/rewrite.ts';
import { setDialect, scalarMax } from '@pigeon-skin/db';

describe('rewriteSql（mysql 目标）', () => {
  it('key 保留字：SELECT/ORDER BY/GROUP BY/INSERT/UPDATE 全位置加反引号，字符串字面量不动', () => {
    expect(rewriteSql("SELECT key, value FROM settings WHERE locale = '' AND key IN (?,?)", 'mysql').sql)
      .toBe("SELECT `key`, value FROM settings WHERE locale = '' AND `key` IN (?,?)");
    expect(rewriteSql("SELECT key FROM settings WHERE locale = ? ORDER BY key", 'mysql').sql)
      .toBe('SELECT `key` FROM settings WHERE locale = ? ORDER BY `key`');
    expect(rewriteSql('SELECT key FROM translation_overrides GROUP BY key', 'mysql').sql)
      .toBe('SELECT `key` FROM translation_overrides GROUP BY `key`');
    expect(rewriteSql("UPDATE settings SET value = 'x' WHERE key = 'k'", 'mysql').sql)
      .toBe("UPDATE settings SET value = 'x' WHERE `key` = 'k'");
    expect(rewriteSql("SELECT 'key stays literal' FROM t WHERE key = ?", 'mysql').sql)
      .toBe("SELECT 'key stays literal' FROM t WHERE `key` = ?");
  });

  it('ON DUPLICATE KEY 的 KEY 不加反引号', () => {
    expect(rewriteSql('INSERT INTO t (a) VALUES (?) ON CONFLICT(a) DO UPDATE SET b = excluded.b', 'mysql').sql)
      .toBe('INSERT INTO t (a) VALUES (?) ON DUPLICATE KEY UPDATE b = VALUES(b)');
  });

  it('INSERT OR IGNORE → INSERT IGNORE；INSERT OR REPLACE → REPLACE', () => {
    expect(rewriteSql('INSERT OR IGNORE INTO t (a) VALUES (?)', 'mysql').sql)
      .toBe('INSERT IGNORE INTO t (a) VALUES (?)');
    expect(rewriteSql('INSERT OR REPLACE INTO t (a) VALUES (?)', 'mysql').sql)
      .toBe('REPLACE INTO t (a) VALUES (?)');
  });

  it('INSERT...RETURNING id → 去掉 RETURNING 并标记模拟', () => {
    const r = rewriteSql('INSERT INTO t (a) VALUES (?) RETURNING id', 'mysql');
    expect(r.sql).toBe('INSERT INTO t (a) VALUES (?)');
    expect(r.emulateInsertReturning).toBe(true);
  });

  it('双引号标识符 → 反引号', () => {
    expect(rewriteSql('SELECT "name" FROM "users"', 'mysql').sql)
      .toBe('SELECT `name` FROM `users`');
  });
});

describe('rewriteSql（postgres 目标）', () => {
  it('INSERT OR IGNORE → INSERT + ON CONFLICT DO NOTHING（语句末尾，仅 INSERT 语句）', () => {
    expect(rewriteSql('INSERT OR IGNORE INTO t (a) VALUES (?)', 'postgres').sql)
      .toBe('INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING');
    // 多行 VALUES
    expect(rewriteSql('INSERT OR IGNORE INTO t (a) VALUES (?), (?)', 'postgres').sql)
      .toBe('INSERT INTO t (a) VALUES (?), (?) ON CONFLICT DO NOTHING');
    // INSERT..SELECT 形态
    expect(rewriteSql('INSERT OR IGNORE INTO t (a) SELECT ? FROM x WHERE y = ?', 'postgres').sql)
      .toBe('INSERT INTO t (a) SELECT ? FROM x WHERE y = ? ON CONFLICT DO NOTHING');
    // 带 RETURNING
    expect(rewriteSql('INSERT OR IGNORE INTO t (a) VALUES (?) RETURNING id', 'postgres').sql)
      .toBe('INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING RETURNING id');
  });

  it('非 INSERT 语句不得追加 ON CONFLICT（第一轮实测缺陷：settings IN 查询与队列轮询被污染）', () => {
    expect(rewriteSql("SELECT key, value FROM settings WHERE locale = '' AND key IN (?,?,?)", 'postgres').sql)
      .toBe("SELECT key, value FROM settings WHERE locale = '' AND key IN (?,?,?)");
    expect(rewriteSql('SELECT id FROM node_jobs WHERE available_at <= ? ORDER BY id LIMIT ?', 'postgres').sql)
      .toBe('SELECT id FROM node_jobs WHERE available_at <= ? ORDER BY id LIMIT ?');
  });

  it('IS ? → IS NOT DISTINCT FROM ?', () => {
    expect(rewriteSql('SELECT * FROM t WHERE model IS ?', 'postgres').sql)
      .toBe('SELECT * FROM t WHERE model IS NOT DISTINCT FROM ?');
  });
});

describe('rewriteSql（sqlite 目标透传）', () => {
  it('原样保留（含 COLLATE NOCASE 与 IS ?）', () => {
    const sql = 'SELECT * FROM t WHERE a = ? COLLATE NOCASE AND model IS ? AND changes() > 0';
    const r = rewriteSql(sql, 'sqlite');
    expect(r.sql).toBe(sql);
    expect(r.plan.every(slot => slot.kind === 'value')).toBe(true);
  });

  it('字符串字面量与注释里的 ? 不计入槽位', () => {
    const r = rewriteSql("SELECT '?' AS a -- c ?\nWHERE x = ?", 'sqlite');
    expect(r.plan).toHaveLength(1);
  });
});

describe('scalarMax（方言分支）', () => {
  let original: 'sqlite' | 'postgres' | 'mysql';
  beforeEach(() => { original = undefined as never; });
  afterEach(() => setDialect(original ?? 'sqlite'));

  it('sqlite 用标量 max，PG/MySQL 用 GREATEST', () => {
    setDialect('sqlite');
    expect(scalarMax('0', 'likes - 1')).toBe('max(0, likes - 1)');
    setDialect('postgres');
    expect(scalarMax('0', 'likes - 1')).toBe('GREATEST(0, likes - 1)');
    setDialect('mysql');
    expect(scalarMax('0', 'likes - 1')).toBe('GREATEST(0, likes - 1)');
  });
});
