// 跨方言搜索谓词的验证。
//
// SQL 片段只有跑到真实数据库上才有意义：sqlite 分支必须真的命中 FTS5 trigram 索引，
// 短查询必须真的回退成 LIKE，通配符必须真的被转义。pg/mysql 分支无法在本机执行，
// 断言其生成文本（这两条路径的正确性由 Node 自托管环境覆盖）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setDialect, textContains, likeLiteral } from '../src/dialect.ts';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type Db = InstanceType<typeof DatabaseSync>;

let db: Db;

beforeEach(() => {
  setDialect('sqlite');
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE textures (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE VIRTUAL TABLE textures_fts USING fts5(name, content = 'textures', content_rowid = 'id', tokenize = 'trigram');
    CREATE TRIGGER textures_fts_insert AFTER INSERT ON textures BEGIN
      INSERT INTO textures_fts(rowid, name) VALUES (new.id, new.name);
    END;
  `);
  for (const name of ['dragon skin', 'verylongskinname', '我的蓝色披风', 'a%b name', 'axb name']) {
    db.prepare('INSERT INTO textures (name) VALUES (?)').run(name);
  }
});

afterEach(() => {
  db.close();
  setDialect('sqlite');
});

/** 用生成的片段查询，返回命中的名字（片段里的 `?` 按 binds 顺序绑定）。 */
function search(value: string, column = 'textures.name'): string[] {
  const fragment = textContains({ column, value, fts: { table: 'textures_fts', column: 'name', key: 'textures.id' } });
  const rows = db.prepare(`SELECT name FROM textures WHERE ${fragment.sql} ORDER BY id`).all(...(fragment.binds as string[])) as Array<{ name: string }>;
  return rows.map(row => row.name);
}

describe('textContains on sqlite', () => {
  it('routes long queries through the FTS5 trigram index', () => {
    expect(search('dragon')).toEqual(['dragon skin']);
    expect(search('longskin')).toEqual(['verylongskinname']);
    expect(search('蓝色披')).toEqual(['我的蓝色披风']);
  });

  it('quotes the value so FTS operators cannot leak in', () => {
    // `OR` 若未被包成短语，FTS 会把它当运算符，命中所有行
    expect(search('dragon OR name')).toEqual([]);
    // 值里的引号要转义成字面量而不是破坏短语结构：既不报错，也不意外命中
    expect(() => search('"dragon')).not.toThrow();
    expect(search('"dragon')).toEqual([]);
  });

  it('falls back to LIKE for queries shorter than three characters', () => {
    // trigram 以 3 字符为单位建索引，2 字查询命中不了 MATCH（见 migrations.test.ts 的锁定用例）
    expect(search('蓝色')).toEqual(['我的蓝色披风']);
    expect(search('dr')).toEqual(['dragon skin']);
  });

  it('switches to instr for values longer than the D1 LIKE pattern budget', () => {
    // D1 把 SQLITE_MAX_LIKE_PATTERN_LENGTH 压到 50：长模式会直接报错，必须换谓词
    const long = 'a'.repeat(60);
    expect(textContains({ column: 'textures.name', value: long }).sql).toBe('instr(lower(textures.name), lower(?)) > 0');
    // 短值仍走 LIKE（保留索引与既有语义）
    expect(textContains({ column: 'textures.name', value: 'a'.repeat(40) }).sql).toContain('LIKE');
  });

  it('matches long values without touching the LIKE pattern limit', () => {
    const name = `${'x'.repeat(60)}needle`;
    db.prepare('INSERT INTO textures (name) VALUES (?)').run(name);
    // 60 字符的值在 D1 上会让 LIKE 报 "pattern too complex"，instr 路径必须正常命中
    expect(search('x'.repeat(60))).toEqual([name]);
    expect(search('NEEDLE')).toEqual([name]);
    expect(search('x'.repeat(30))).toEqual([name]);
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(search('a%b')).toEqual(['a%b name']);
    expect(search('a_b')).toEqual([]);
  });

  it('generates no fragment for an empty value only when the caller skips it', () => {
    // 空值会生成 LIKE '%%'，命中所有行 —— 调用方必须自行跳过空表达式，这条用例锁住该语义
    expect(search('').length).toBe(5);
  });
});

describe('textContains across dialects', () => {
  it('uses ILIKE on postgres (pg_trgm serves the index without a subquery)', () => {
    setDialect('postgres');
    const fragment = textContains({ column: 'textures.name', value: 'dragon', fts: { table: 'textures_fts', column: 'name', key: 'textures.id' } });
    expect(fragment.sql).toBe('textures.name ILIKE ?');
    expect(fragment.binds).toEqual(['%dragon%']);
  });

  it('uses the ngram boolean-mode subquery on mysql', () => {
    setDialect('mysql');
    const fragment = textContains({ column: 'textures.name', value: 'dragon', fts: { table: 'textures_fts', column: 'name', key: 'textures.id' } });
    expect(fragment.sql).toBe('textures.id IN (SELECT rowid FROM textures_fts WHERE MATCH(name) AGAINST(? IN BOOLEAN MODE))');
    expect(fragment.binds).toEqual(['"*dragon*"']);
  });

  it('uses strpos / INSTR for long values on the other dialects', () => {
    setDialect('postgres');
    expect(textContains({ column: 'textures.name', value: 'a'.repeat(60) }).sql).toBe('strpos(lower(textures.name), lower(?)) > 0');
    setDialect('mysql');
    expect(textContains({ column: 'textures.name', value: 'a'.repeat(60) }).sql).toBe('INSTR(LOWER(textures.name), LOWER(?)) > 0');
  });

  it('omits the ESCAPE clause on databases whose LIKE already escapes with a backslash', () => {
    setDialect('mysql');
    expect(textContains({ column: 'textures.name', value: 'dr' }).sql).toBe('textures.name LIKE ?');
    setDialect('postgres');
    expect(textContains({ column: 'textures.name', value: 'dr' }).sql).toBe('textures.name ILIKE ?');
    setDialect('sqlite');
    expect(textContains({ column: 'textures.name', value: 'dr' }).sql).toBe(`textures.name LIKE ? ESCAPE '\\'`);
  });

  it('escapes backslash, percent and underscore', () => {
    expect(likeLiteral('100%_x\\y')).toBe('100\\%\\_x\\\\y');
  });
});
