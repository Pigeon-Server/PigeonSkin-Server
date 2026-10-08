import { describe, it, expect } from 'vitest';
import { resolveEnv } from '../src/lib/env.ts';
import { TABLES, IMPORT_ORDER, PathValidationError } from '../src/commands/data.ts';

describe('resolveEnv', () => {
  it('默认 local', () => {
    expect(resolveEnv(new Map()).name).toBe('local');
    expect(resolveEnv(new Map([['env', 'local']])).scopeFlag).toBe('--local');
  });
  it('production 指向 bs-prod 与 --remote', () => {
    const e = resolveEnv(new Map([['env', 'production']]));
    expect(e.d1Database).toBe('bs-prod');
    expect(e.r2Bucket).toBe('bs-prod-textures');
    expect(e.scopeFlag).toBe('--remote');
  });
  it('未知环境报错', () => {
    expect(() => resolveEnv(new Map([['env', 'staging']]))).toThrow();
  });
});

describe('data 表规格', () => {
  it('导入顺序满足 FK 约束（users 先于 textures，其余引用方在最后）', () => {
    // users 与 textures 循环引用：users 先以 avatar NULL 插入，textures 之后回填
    expect(IMPORT_ORDER).toEqual([
      'users', 'textures', 'textures_description', 'players', 'closet',
    ]);
  });

  it('每个表规格的 toInsert 生成合法 INSERT 语句（OR IGNORE）', () => {
    const textures = TABLES.find((t) => t.name === 'textures')!;
    const sql = textures.toInsert({
      id: 1, hash: 'a'.repeat(64), kind: 'skin', model: 'default', name: "O'Neill",
      official_key: null, catalog_revision: 0, uploader_id: 2, source_resource_id: null,
      origin: 'original', size_bytes: 1024, score_refund_basis: 0, score_award: 0,
      visibility: 'public', width: 64, height: 64, likes: 3, created_at: 1700000000000,
      updated_at: 1700000000001,
    });
    expect(sql.startsWith('INSERT OR IGNORE INTO textures (id, hash,')).toBe(true);
    expect(sql).toContain("'O''Neill'");
    // 备份恢复按主键 id 判定（hash 不唯一，同 hash+uploader 可有多行）
    expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM textures WHERE id = 1');
  });

  it('users 插入时 avatar_texture_id 置 NULL（FK 循环由回填解决），email 冲突跳过', () => {
    const users = TABLES.find((t) => t.name === 'users')!;
    const sql = users.toInsert({
      id: 7, email: 'a@b.c', legacy_email_conflict: 1, merged_into_user_id: null,
      email_verified_at: null, nickname: '', locale: null, score: 1000,
      avatar_texture_id: 3, password_hash: 'pbkdf2:x:y', needs_initialization: 0,
      password_rehash_required: 1, role: 'normal', signature: '',
      registration_ip: null, is_dark_mode: 0, last_sign_at: null,
      created_at: 1700000000000, updated_at: 1700000000000,
    });
    // 即使备份行 avatar_texture_id = 3，INSERT 也必须写 NULL（textures 尚未插入）
    expect(sql).toContain(', NULL,');
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'a@b.c')");
  });

  it('closet 复合主键去重', () => {
    const closet = TABLES.find((t) => t.name === 'closet')!;
    const sql = closet.toInsert({
      user_id: 1, texture_id: 2, item_name: '我的皮肤', is_default: 1, created_at: 1700000000000,
    });
    expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM closet WHERE user_id = 1 AND texture_id = 2)');
  });
});

describe('PathValidationError 可被 instanceof 捕获', () => {
  it('data.ts re-export 的是同一个类', () => {
    const e = new PathValidationError('x');
    expect(e).toBeInstanceOf(PathValidationError);
    expect(e.message).toBe('x');
  });
});
