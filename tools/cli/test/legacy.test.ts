import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDump, splitValues, convertValue, loadDumpIntoSqlite } from '../src/commands/legacy/dump-source.ts';
import { parseLegacyEnvText, discoverSource, discoverTexturesDir } from '../src/commands/legacy/discover.ts';

const tempDirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cli-legacy-test-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseDump 状态机', () => {
  it('提取目标表的 CREATE 列与 INSERT 元组，跳过非目标表', () => {
    const sql = `
-- 注释
CREATE TABLE \`ads\` (\`id\` int NOT NULL);
CREATE TABLE \`users\` (
  \`uid\` int NOT NULL,
  \`email\` varchar(100) NOT NULL,
  \`password\` varchar(255) NOT NULL,
  PRIMARY KEY (\`uid\`)
) ENGINE=InnoDB;
CREATE TABLE \`textures\` (\`tid\` int, \`hash\` varchar(64));
INSERT INTO \`users\` (\`uid\`, \`email\`, \`password\`) VALUES
(1, 'a@b.c', '$2y$10$abc'),
(2, 'd@e.f', 'x''y\\'z');
INSERT INTO \`ads\` (\`id\`) VALUES (99);
`;
    const parsed = parseDump(sql);
    expect(parsed.columns.get('users')).toEqual(['uid', 'email', 'password']);
    expect(parsed.columns.get('textures')).toEqual(['tid', 'hash']);
    expect(parsed.columns.has('ads')).toBe(false);
    expect(parsed.rows.get('users')).toEqual([
      "1, 'a@b.c', '$2y$10$abc'",
      "2, 'd@e.f', 'x''y\\'z'",
    ]);
    expect(parsed.rows.has('ads')).toBe(false);
  });

  it('字符串内的分号/引号/转义不切断语句', () => {
    const sql = `INSERT INTO \`players\` (\`pid\`, \`name\`) VALUES
(1, 'it;s got; semicolons'),
(2, 'back\\\\slash and \\'quote\\''),
(3, 'emoji 😀 ok');`;
    const parsed = parseDump(sql);
    expect(parsed.rows.get('players')!.length).toBe(3);
  });

  it('DELIMITER 区（存储过程/事件）作为非分隔语句被整体跳过', () => {
    const sql = `
DELIMITER $$
CREATE EVENT x ON SCHEDULE EVERY 5 SECOND DO SET active = 1 WHERE a;b$$
DELIMITER ;
INSERT INTO \`textures\` (\`tid\`, \`hash\`) VALUES (1, 'aa');`;
    const parsed = parseDump(sql);
    expect(parsed.rows.get('textures')).toEqual(["1, 'aa'"]);
  });

  it('条件注释 /*!40101 */ 不干扰解析', () => {
    const sql = `/*!40101 SET NAMES utf8mb4 */;
INSERT INTO \`users\` (\`uid\`, \`email\`) VALUES (1, 'x@y.z');`;
    const parsed = parseDump(sql);
    expect(parsed.rows.get('users')).toEqual(["1, 'x@y.z'"]);
  });

  it('回归：同表多条 INSERT 的元组累积合并（大表分块导出）', () => {
    const sql = `INSERT INTO \`users\` (\`uid\`, \`email\`) VALUES (1, 'a@b.c'), (2, 'd@e.f');
INSERT INTO \`users\` (\`uid\`, \`email\`) VALUES (3, 'g@h.i');
INSERT INTO \`users\` (\`uid\`, \`email\`) VALUES (4, 'j@k.l'), (5, 'm@n.o');`;
    const parsed = parseDump(sql);
    expect(parsed.rows.get('users')!.length).toBe(5);
  });

  it('回归：元组内字符串含 ")(" 或 "),(" 不被错切', () => {
    const sql = `INSERT INTO \`users\` (\`uid\`, \`nickname\`) VALUES
(1, 'arrow => (x,y) end'),
(2, 'tuple lookalike ) ,( not a boundary'),
(3, 'plain');`;
    const parsed = parseDump(sql);
    const rows = parsed.rows.get('users')!;
    expect(rows.length).toBe(3);
    expect(rows[0]).toContain('(x,y)');
  });

  it("回归：空字符串 '' 是完整值而不是未闭合字符串", () => {
    const sql = `INSERT INTO \`users\` (\`uid\`, \`nickname\`, \`email\`) VALUES
(1, '', 'a@b.c'),
(2, 'x', 'd@e.f');`;
    const parsed = parseDump(sql);
    expect(parsed.rows.get('users')!.length).toBe(2);
  });

  it('convertValue 处理 \\b 与 \\Z（MySQL 特有转义）', () => {
    expect(convertValue("'a\\bb'")).toBe('a\bb');
    expect(convertValue("'a\\Zb'")).toBe('a\x1ab');
  });

  it('回归：notifications 去重键的 created_at 端格式一致（epoch 毫秒，非 datetime 字符串）', async () => {
    // P0 复验点：目标库存 mapNotification 输出的 epoch 毫秒，
    // 源侧行必须经 legacyDateTimeToEpoch(±时区) 换算后才能构造同格式键。
    // migrate-run 的 stageNotificationsDeduped 用同一实现构造源侧键。
    const { legacyDateTimeToEpoch } = await import('@pigeon-skin/migrate/src/lib/date');
    const epoch = legacyDateTimeToEpoch('2023-02-17 01:47:41', 'Asia/Shanghai');
    expect(epoch).toBe(1676569661000);
    expect(typeof epoch).toBe('number');
  });
});

describe('splitValues / convertValue', () => {
  it('按顶层逗号切分，字符串内的逗号/括号保留', () => {
    expect(splitValues("1, 'a,b(c)', NULL, 'x''y'")).toEqual(["1", " 'a,b(c)'", ' NULL', " 'x''y'"]);
  });
  it('MySQL 值转换：NULL/整数/负数/字符串反转义', () => {
    expect(convertValue('NULL')).toBeNull();
    expect(convertValue('42')).toBe(42);
    expect(convertValue('-7')).toBe(-7);
    expect(convertValue("'line\\nbreak'")).toBe('line\nbreak');
    expect(convertValue("'it\\'s'")).toBe("it's");
    expect(convertValue("'back\\\\slash'")).toBe('back\\slash');
  });
});

describe('loadDumpIntoSqlite', () => {
  it('最小 dump：users/textures/players/user_closet 进临时 SQLite', () => {
    const dir = tempDir();
    const dump = join(dir, 'dump.sql');
    writeFileSync(dump, `
CREATE TABLE \`users\` (\`uid\` int, \`email\` varchar(100), \`password\` varchar(255), \`permission\` int, \`score\` int, \`register_at\` datetime);
INSERT INTO \`users\` (\`uid\`, \`email\`, \`password\`, \`permission\`, \`score\`, \`register_at\`) VALUES
(1, 'a@b.c', '$2y$10$hash1', 2, 1000, '2023-02-17 01:47:41');
CREATE TABLE \`textures\` (\`tid\` int, \`hash\` varchar(64), \`type\` varchar(10));
INSERT INTO \`textures\` (\`tid\`, \`hash\`, \`type\`) VALUES (7, 'a'.repeat(64) , 'steve');
`);
    const warnings: string[] = [];
    const dump1 = loadDumpIntoSqlite(dump, (m) => warnings.push(m));
    try {
      const users = dump1.db.prepare('SELECT * FROM users').all() as Record<string, unknown>[];
      expect(users.length).toBe(1);
      expect(users[0]!['email']).toBe('a@b.c');
      expect(users[0]!['permission']).toBe(2);
      expect(dump1.rowCounts['users']).toBe(1);
    } finally {
      dump1.close();
    }
  });

  it('列数不匹配的行跳过并产生警告', () => {
    const dir = tempDir();
    const dump = join(dir, 'dump.sql');
    writeFileSync(dump, `CREATE TABLE \`options\` (\`option_name\` varchar(50), \`option_value\` text);
INSERT INTO \`options\` (\`option_name\`, \`option_value\`) VALUES ('site_name', 'x'), ('bad_row_only');`);
    const warnings: string[] = [];
    const dump1 = loadDumpIntoSqlite(dump, (m) => warnings.push(m));
    try {
      expect(dump1.rowCounts['options']).toBe(2);
      const rows = dump1.db.prepare('SELECT * FROM options').all();
      expect(rows.length).toBe(1);
      expect(warnings.some((w) => w.includes('列数不匹配'))).toBe(true);
    } finally {
      dump1.close();
    }
  });
});

describe('parseLegacyEnvText / discoverSource', () => {
  it('解析 DB_* / PWD_METHOD / SALT，处理引号与注释', () => {
    const env = parseLegacyEnvText([
      '# 注释',
      'DB_CONNECTION=mysql',
      'DB_HOST=localhost',
      'DB_PORT=3306',
      'DB_DATABASE=blessingskin',
      'DB_USERNAME=root',
      'DB_PASSWORD="p@ss\'word"',
      'PWD_METHOD=BCRYPT',
    ].join('\n'));
    expect(env.dbDatabase).toBe('blessingskin');
    expect(env.dbPassword).toBe("p@ss'word");
    expect(env.pwdMethod).toBe('BCRYPT');
  });

  it('.env DB 完整 → mysql 模式；否则回落 dump', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'DB_HOST=localhost\nDB_DATABASE=bs\nDB_USERNAME=root\nPWD_METHOD=BCRYPT\n');
    writeFileSync(join(dir, 'backup.sql'), 'INSERT INTO `users` (`uid`) VALUES (1);');
    const discovered = discoverSource(dir);
    expect(discovered.kind).toBe('mysql');
  });

  it('无 .env 时选最大的 *.sql；显式 --dump 优先', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'small.sql'), 'x');
    writeFileSync(join(dir, 'big.sql'), 'xx');
    expect(discoverSource(dir).kind).toBe('dump');
    const explicit = discoverSource(dir, join(dir, 'small.sql'));
    expect(explicit.dumpPath).toBe(join(dir, 'small.sql'));
  });

  it('既无 .env 也无 dump 时报错', () => {
    const dir = tempDir();
    expect(() => discoverSource(dir)).toThrow(/dump/);
  });

  it('storage/textures 存在时被发现', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'storage', 'textures'), { recursive: true });
    expect(discoverTexturesDir(dir)).toBe(join(dir, 'storage', 'textures'));
    expect(discoverTexturesDir(tempDir())).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });
});
