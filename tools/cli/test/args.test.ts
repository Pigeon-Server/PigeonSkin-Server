import { describe, it, expect } from 'vitest';
import { parseArgs, flagString, flagInt, hasFlag } from '../src/lib/args.ts';
import { sqlText, sqlIntOrNull, isHashHex, normalizeEmail } from '../src/lib/sql.ts';
import { safeBaseName } from '../src/lib/paths.ts';
import { PathValidationError } from '../src/lib/paths.ts';

describe('parseArgs', () => {
  it('解析子命令路径与值参数', () => {
    const p = parseArgs(['users', 'create', '--email', 'a@b.c', '--nickname', '名']);
    expect(p.path).toEqual(['users', 'create']);
    expect(flagString(p.flags, 'email')).toBe('a@b.c');
    expect(flagString(p.flags, 'nickname')).toBe('名');
  });

  it('布尔开关不吞下一个值', () => {
    const p = parseArgs(['data', 'import', '--yes', '--from', './x']);
    expect(hasFlag(p.flags, 'yes')).toBe(true);
    expect(flagString(p.flags, 'from')).toBe('./x');
  });

  it('带值的开关后面紧跟另一个 -- 不视为布尔', () => {
    expect(() => parseArgs(['users', 'list', '--search'])).toThrow('需要一个值');
  });

  it('裸位置参数进入路径', () => {
    const p = parseArgs(['settings', 'get', '--key', 'site_name']);
    expect(p.path).toEqual(['settings', 'get']);
  });

  it('-h 视为帮助开关', () => {
    const p = parseArgs(['-h']);
    expect(hasFlag(p.flags, 'help')).toBe(true);
  });
});

describe('flagInt', () => {
  it('正整数可用', () => {
    const p = parseArgs(['x', '--limit', '10']);
    expect(flagInt(p.flags, 'limit')).toBe(10);
  });
  it('非正整数报错', () => {
    const p = parseArgs(['x', '--limit', '0']);
    expect(() => flagInt(p.flags, 'limit')).toThrow();
  });
});

describe('sqlText / sqlIntOrNull', () => {
  it('单引号转义', () => {
    expect(sqlText("it's O'K")).toBe(`'it''s O''K'`);
  });
  it('null → NULL，非法整数报错', () => {
    expect(sqlIntOrNull(null)).toBe('NULL');
    expect(sqlIntOrNull(5)).toBe('5');
    expect(() => sqlIntOrNull(1.5)).toThrow();
    expect(() => sqlIntOrNull(Number.NaN)).toThrow();
  });
});

describe('isHashHex / normalizeEmail', () => {
  it('仅接受小写 64 位 hex', () => {
    expect(isHashHex('a'.repeat(64))).toBe(true);
    expect(isHashHex('A'.repeat(64))).toBe(false);
    expect(isHashHex('a'.repeat(63))).toBe(false);
    expect(isHashHex(null)).toBe(false);
  });
  it('邮箱规范化与拒绝', () => {
    expect(normalizeEmail('  a@B.c ')).toBe('a@B.c');
    expect(() => normalizeEmail('no-at-sign')).toThrow();
    expect(() => normalizeEmail('a b@c.d')).toThrow();
  });
});

describe('safeBaseName', () => {
  it('允许常规文件名，拒绝路径注入', () => {
    expect(safeBaseName('abc_123.png')).toBe('abc_123.png');
    expect(() => safeBaseName('../evil')).toThrow(PathValidationError);
    expect(() => safeBaseName('a/b')).toThrow(PathValidationError);
    expect(() => safeBaseName('')).toThrow(PathValidationError);
  });
});
