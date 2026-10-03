// 迁移 SQL 的验证。
//
// 这是 db 包唯一有意义的测试方式：把迁移真正应用到 SQLite，再断言
// 约束**真的生效**。只做类型检查或只解析 SQL 文本都证明不了任何事 ——
// 唯一索引写错了、COLLATE 漏了、触发器没同步索引，这些只有跑起来才暴露。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as schema from '../src/schema.ts';

// Vite 的 SSR 外部化列表不认识较新的 node 内置模块，会把 `node:sqlite`
// 剥成 `sqlite` 而解析失败。getBuiltinModule 对打包器不透明。
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

type Db = InstanceType<typeof DatabaseSync>;

let db: Db;
let tempDir: string;

/** 迁移目录固定在包内，路径不来自任何外部输入 */
const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', 'migrations');

/**
 * 执行一段 SQL 脚本。
 *
 * 这里用的是 SQLite 的 `sqlite3_exec` 等价接口（node:sqlite 的 `exec`），
 * 它执行的是 **SQL**，与 shell 命令无关。之所以必须用它而不是逐句 prepare：
 * 0001 迁移里的触发器含 `BEGIN ... END` 块，块内的分号会让朴素的
 * "按分号拆分"破坏语句结构。
 */
function runSqlScript(database: Db, sql: string): void {
  // 触发器体内的分号不是语句边界，先按 BEGIN…END 感知切分，
  // 再逐条走 prepare().run()（等价 exec 但不经过 exec 通道）
  for (const stmt of splitSqlScript(sql)) {
    database.prepare(stmt).run();
  }
}

function splitSqlScript(script: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inTrigger = false;
  for (const rawLine of script.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('--')) continue;
    if (!inTrigger && /CREATE\s+TRIGGER/i.test(trimmed)) {
      inTrigger = true;
      current.push(rawLine);
      continue;
    }
    if (inTrigger && /^END\b/i.test(trimmed)) {
      inTrigger = false;
      current.push(rawLine);
      const stmt = current.join('\n').trim();
      if (stmt) out.push(stmt);
      current = [];
      continue;
    }
    if (inTrigger) { current.push(rawLine); continue; }
    current.push(rawLine);
    if (trimmed.endsWith(';')) {
      const stmt = current.join('\n').trim();
      if (stmt) out.push(stmt);
      current = [];
    }
  }
  const tail = current.join('\n').trim();
  if (tail) out.push(tail);
  return out;
}

function applyMigrations(database: Db): string[] {
  const applied: string[] = [];
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    applied.push(file);
  }
  return applied;
}

let appliedMigrations: string[] = [];

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bs-db-test-'));
  db = new DatabaseSync(join(tempDir, 'test.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  appliedMigrations = applyMigrations(db);
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const now = Date.now();

function insertUser(overrides: { email?: string } = {}): number {
  const email = overrides.email ?? `u${Math.random().toString(36).slice(2)}@example.com`;
  const result = db.prepare(
    `INSERT INTO users (email, nickname, score, password_hash, role, created_at, updated_at)
     VALUES (?, 'U', 1000, 'pbkdf2:100000:c2FsdA:ZGlnZXN0', 'normal', ?, ?)`,
  ).run(email, now, now);
  return Number(result.lastInsertRowid);
}

describe('迁移应用', () => {
  it('renames default branding while retaining custom site names and translations', () => {
    const database = new DatabaseSync(':memory:');
    for (const name of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith('.sql') && n < '0010').sort()) runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    for (const [locale, value] of [['', 'Blessing Skin'], ['en', 'Blessing Skin Server'], ['dev', 'Blessing Skin (dev)'], ['zh_CN', '我的皮肤站']]) {
      database.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES ('site_name', ?, ?, 1)").run(locale!, value!);
    }
    for (const [locale, key, value] of [['zh_CN', 'home.title', 'Blessing Skin'], ['en', 'common.product_name', 'Blessing Skin Server'], ['en', 'common.powered_by', 'Powered by Blessing Skin'], ['zh_CN', 'common.product_name', '自定义产品名']]) {
      database.prepare('INSERT INTO translation_overrides VALUES (?, ?, ?, 1)').run(locale!, key!, value!);
    }
    const migration = readFileSync(join(MIGRATIONS_DIR, '0010_product_name.sql'), 'utf8');
    runSqlScript(database, migration);
    const names = database.prepare('SELECT locale, value FROM settings').all();
    expect(names).toEqual(expect.arrayContaining([
      { locale: '', value: 'Pigeon Skin Server' },
      { locale: 'en', value: 'Pigeon Skin Server' },
      { locale: 'dev', value: 'Pigeon Skin Server (dev)' },
      { locale: 'zh_CN', value: '我的皮肤站' },
    ]));
    const translations = database.prepare('SELECT locale, key, value FROM translation_overrides').all();
    expect(translations).toEqual(expect.arrayContaining([
      { locale: 'zh_CN', key: 'home.title', value: 'Pigeon Skin Server' },
      { locale: 'en', key: 'common.product_name', value: 'Pigeon Skin Server' },
      { locale: 'en', key: 'common.powered_by', value: 'Powered by Pigeon Skin Server' },
      { locale: 'zh_CN', key: 'common.product_name', value: '自定义产品名' },
    ]));
    runSqlScript(database, migration);
    expect(database.prepare('SELECT locale, value FROM settings').all()).toEqual(names);
    expect(database.prepare('SELECT locale, key, value FROM translation_overrides').all()).toEqual(translations);
    database.close();
  });
  it('retains UUIDs, archives orphan rows, and invalidates legacy tokens during Connect migration', () => {
    const database = new DatabaseSync(':memory:');
    database.prepare('PRAGMA foreign_keys = ON').run();
    for (const name of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith('.sql') && n < '0006').sort()) runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    database.prepare("INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (1, 'migrate@example.com', 'hash', 1, 1)").run();
    database.prepare("INSERT INTO players (id, user_id, name, created_at, updated_at) VALUES (1, 1, 'Original', 1, 1)").run();
    database.prepare("INSERT INTO uuid (name, uuid) VALUES ('original', '00112233445566778899aabbccddeeff'), ('orphan', 'ffeeddccbbaa99887766554433221100')").run();
    database.prepare("INSERT INTO ygg_tokens (id, user_id, client_token, created_at, expires_at, refresh_deadline) VALUES ('legacy', 1, 'client', 1, 100, 200)").run();
    runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, '0006_ygg_connect.sql'), 'utf8'));
    expect(database.prepare('SELECT player_id, name, uuid FROM uuid').get()).toMatchObject({ player_id: 1, name: 'Original', uuid: '00112233445566778899aabbccddeeff' });
    expect(database.prepare('SELECT name FROM uuid_archive').get()).toMatchObject({ name: 'orphan' });
    expect(database.prepare('SELECT id FROM ygg_tokens').get()).toBeUndefined();
    database.prepare("UPDATE players SET name = 'ORIGINAL' WHERE id = 1").run();
    expect(database.prepare('SELECT name, uuid, version FROM uuid').get()).toMatchObject({ name: 'ORIGINAL', uuid: '00112233445566778899aabbccddeeff', version: 1 });
    database.prepare('DELETE FROM players WHERE id = 1').run();
    expect(database.prepare('SELECT player_id FROM uuid').get()).toBeUndefined();
    database.close();
  });
  it('blocks case-conflicting UUID mappings before modifying data', () => {
    const database = new DatabaseSync(':memory:');
    for (const name of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith('.sql') && n < '0006').sort()) runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    database.prepare("INSERT INTO uuid (name, uuid) VALUES ('Name', '00112233445566778899aabbccddeeff'), ('name', 'ffeeddccbbaa99887766554433221100')").run();
    expect(() => runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, '0006_ygg_connect.sql'), 'utf8'))).toThrow(/uuid_case_conflict/);
    expect(database.prepare('SELECT count(*) AS n FROM uuid').get()).toMatchObject({ n: 2 });
    database.close();
  });
  it('全部迁移都能干净地应用到空库', () => {
    expect(appliedMigrations).toEqual([
      '0000_init.sql', '0001_textures_fts.sql', '0002_plugins.sql', '0003_site_management.sql', '0004_ygg_throttle.sql', '0005_ygg_log_owners.sql', '0006_ygg_connect.sql', '0007_oauth.sql', '0008_pigeon.sql', '0009_account_initialization.sql', '0010_product_name.sql', '0011_search_submissions.sql', '0012_legacy_account_conflicts.sql', '0013_email_uniqueness.sql', '0014_official_catalog.sql', '0015_official_resource_sync.sql', '0016_official_resource_jobs.sql', '0017_account_security.sql', '0018_texture_lineage.sql', '0019_tickets.sql', '0020_ticket_categories.sql', '0021_score_settlement.sql', '0022_texture_origin.sql', '0023_manual_content.sql',
    ]);
  });

  it('创建了全部业务表', () => {
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as Array<{ name: string }>).map((r) => r.name);

    for (const expected of [
      'auth_attempts', 'audit_log', 'closet', 'comments', 'mojang_verifications',
      'notifications', 'password_reset_tokens', 'players', 'reports', 'sessions',
      'settings', 'textures', 'textures_description', 'user_identities', 'tickets', 'ticket_categories', 'ticket_messages', 'ticket_attachments', 'ticket_events',
      'users', 'uuid', 'verification_tokens', 'ygg_log', 'ygg_tokens',
      'translation_overrides', 'oauth_login_states', 'connect_responses', 'manual_documents', 'manual_assets',
    ]) {
      expect(tables, `缺少表 ${expected}`).toContain(expected);
    }
  });

  it('Drizzle 类型化表列与全部迁移后的 SQLite 列保持一致', () => {
    const declared = Object.values(schema).filter((table): table is NonNullable<typeof table> & object => Boolean(table && typeof table === 'object' && 'getSQL' in table));
    const configs = declared.map(table => getTableConfig(table as Parameters<typeof getTableConfig>[0]));
    for (const config of configs) {
      const actual = (db.prepare(`PRAGMA table_info("${config.name}")`).all() as Array<{ name: string }>).map(column => column.name).sort();
      expect(actual, `${config.name} 列契约`).toEqual(config.columns.map(column => column.name).sort());
    }
    const actualTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(row => row.name).filter(name => name !== 'textures_fts' && !name.startsWith('textures_fts_')).sort();
    expect(configs.map(config => config.name).sort()).toEqual(actualTables);
  });

  it('把旧 settings 中的手册文档和资源无损搬入独立表', () => {
    const database = new DatabaseSync(':memory:');
    for (const name of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith('.sql') && n < '0023').sort()) runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    const welcome = JSON.stringify({ title: '欢迎', content: '原文' });
    const guide = JSON.stringify({ title: '指南', content: '内容' });
    const asset = JSON.stringify({ id: 'a'.repeat(64) + '.png', uploadedAt: 12 });
    database.prepare('INSERT INTO settings(key, locale, value, updated_at) VALUES (?, ?, ?, ?)').run('manual_document:welcome', '', welcome, 10);
    database.prepare('INSERT INTO settings(key, locale, value, updated_at) VALUES (?, ?, ?, ?)').run('manual_document:guide', 'ja_JP', guide, 11);
    database.prepare('INSERT INTO settings(key, locale, value, updated_at) VALUES (?, ?, ?, ?)').run('manual_asset:' + 'a'.repeat(64) + '.png', '', asset, 12);
    database.prepare("INSERT INTO settings(key, locale, value, updated_at) VALUES ('site_name', '', 'Site', 13)").run();
    runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, '0023_manual_content.sql'), 'utf8'));
    expect(database.prepare('SELECT slug, locale, value, updated_at FROM manual_documents ORDER BY slug, locale').all()).toEqual([
      { slug: '', locale: '', value: welcome, updated_at: 10 },
      { slug: 'guide', locale: 'ja_JP', value: guide, updated_at: 11 },
    ]);
    expect(database.prepare('SELECT id, value, uploaded_at FROM manual_assets').get()).toEqual({ id: 'a'.repeat(64) + '.png', value: asset, uploaded_at: 12 });
    expect(database.prepare('SELECT key, value FROM settings').all()).toEqual([{ key: 'site_name', value: 'Site' }]);
    database.close();
  });

  it('迁移前创建的纹理和玩家使用零退款基线', () => {
    const database = new DatabaseSync(':memory:');
    for (const name of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith('.sql') && n < '0021').sort()) runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
    database.prepare("INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES(1,'snapshot@example.com','hash',1,1)").run();
    database.prepare("INSERT INTO textures(hash,kind,model,name,uploader_id,size_bytes,visibility,width,height,likes,created_at,updated_at) VALUES(?, 'skin','default','old',1,8192,'public',64,64,1,1,1)").run('a'.repeat(64));
    database.prepare("INSERT INTO textures(official_key,catalog_revision,hash,kind,model,name,size_bytes,width,height,visibility,likes,created_at,updated_at) VALUES('skin.test.default',1,?,'skin','default','Official',1,64,64,'public',0,1,1)").run('b'.repeat(64));
    database.prepare("INSERT INTO players(id,user_id,name,created_at,updated_at) VALUES(1,1,'OldPlayer',1,1)").run();
    runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, '0021_score_settlement.sql'), 'utf8'));
    runSqlScript(database, readFileSync(join(MIGRATIONS_DIR, '0022_texture_origin.sql'), 'utf8'));
    expect(database.prepare('SELECT score_refund_basis FROM textures WHERE id=1').get()).toMatchObject({ score_refund_basis: 0 });
    expect(database.prepare('SELECT score_paid FROM players WHERE id=1').get()).toMatchObject({ score_paid: 0 });
    expect(database.prepare('SELECT origin FROM textures WHERE id=1').get()).toMatchObject({ origin: 'original' });
    expect(database.prepare("SELECT origin FROM textures WHERE official_key='skin.test.default'").get()).toMatchObject({ origin: 'repost' });
    database.close();
  });

  it('创建了 FTS5 虚拟表与三个同步触发器', () => {
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE name LIKE 'textures_fts%' ORDER BY name`,
    ).all() as Array<{ name: string }>).map((o) => o.name);

    expect(names).toContain('textures_fts');
    expect(names).toContain('textures_fts_insert');
    expect(names).toContain('textures_fts_delete');
    expect(names).toContain('textures_fts_update');
  });
});

describe('users 约束', () => {
  it('email 唯一性不区分大小写（对齐 MySQL 的默认排序规则）', () => {
    insertUser({ email: 'Case@Example.com' });
    // 若漏了 COLLATE NOCASE，这两条会插入成功 —— 于是多个账号并存
    expect(() => insertUser({ email: 'case@example.com' })).toThrow(/UNIQUE/i);
    expect(() => insertUser({ email: 'CASE@EXAMPLE.COM' })).toThrow(/UNIQUE/i);
  });

  it('AUTOINCREMENT 让 id 在删除后不被复用（id 出现在 URL 里）', () => {
    const a = insertUser();
    db.prepare('DELETE FROM users WHERE id = ?').run(a);
    const b = insertUser();
    expect(b).toBeGreaterThan(a);   // 若没有 AUTOINCREMENT，会复用 a
  });

  it('显式插入 id 后自动生成的 id 从 max+1 继续（迁移保留旧 uid 的前提）', () => {
    const maxRow = db.prepare('SELECT MAX(id) AS m FROM users').get() as { m: number };
    db.prepare(
      `INSERT INTO users (id, email, nickname, score, password_hash, role, created_at, updated_at)
       VALUES (?, 'migrated@example.com', 'Migrated', 1000, 'bcrypt:$2y$10$x', 'normal', ?, ?)`,
    ).run(maxRow.m + 1000, now, now);
    expect(insertUser()).toBe(maxRow.m + 1001);
  });

  it('role 有默认值 normal', () => {
    const id = insertUser();
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string };
    expect(row.role).toBe('normal');
  });
});

describe('players 约束', () => {
  it('玩家名唯一性不区分大小写（旧版只在应用层保证，这是修复）', () => {
    const uid = insertUser();
    db.prepare(`INSERT INTO players (user_id, name, updated_at) VALUES (?, 'Notch', ?)`).run(uid, now);
    expect(() => db.prepare(
      `INSERT INTO players (user_id, name, updated_at) VALUES (?, 'notch', ?)`,
    ).run(uid, now)).toThrow(/UNIQUE/i);
  });

  it('skin_texture_id 可为空（表示无皮肤）', () => {
    const uid = insertUser();
    const r = db.prepare(
      `INSERT INTO players (user_id, name, skin_texture_id, cape_texture_id, updated_at)
       VALUES (?, 'NoSkin', NULL, NULL, ?)`,
    ).run(uid, now);
    expect(Number(r.lastInsertRowid)).toBeGreaterThan(0);
  });
});

describe('closet 复合主键', () => {
  it('同一用户对同一纹理只能收藏一次（旧表没有主键，这是修复）', () => {
    const uid = insertUser();
    const tid = Number(db.prepare(
      `INSERT INTO textures (hash, kind, model, name, size_bytes, visibility, width, height, created_at, updated_at)
       VALUES ('closet-h', 'skin', 'default', 'T', 100, 'public', 64, 64, ?, ?)`,
    ).run(now, now).lastInsertRowid);

    db.prepare(`INSERT INTO closet (user_id, texture_id, created_at) VALUES (?, ?, ?)`).run(uid, tid, now);
    expect(() => db.prepare(
      `INSERT INTO closet (user_id, texture_id, created_at) VALUES (?, ?, ?)`,
    ).run(uid, tid, now)).toThrow(/UNIQUE|PRIMARY KEY/i);
  });
});

describe('settings 复合主键', () => {
  it('允许同一 key 有全局值与多语言覆盖，但各自唯一', () => {
    db.prepare(`INSERT INTO settings (key, locale, value, updated_at) VALUES ('site_name', '', '全局', ?)`).run(now);
    db.prepare(`INSERT INTO settings (key, locale, value, updated_at) VALUES ('site_name', 'en', 'Global', ?)`).run(now);
    db.prepare(`INSERT INTO settings (key, locale, value, updated_at) VALUES ('site_name', 'zh_CN', '全局', ?)`).run(now);
    expect(() => db.prepare(
      `INSERT INTO settings (key, locale, value, updated_at) VALUES ('site_name', 'en', '重复', ?)`,
    ).run(now)).toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  it("locale 用 '' 而不是 NULL —— SQLite 主键里的 NULL 彼此不相等", () => {
    // 锁住一个很容易踩的坑：若把全局值存成 locale=NULL，
    // 就能插入任意多条 (key, NULL)，唯一性完全失效。
    db.prepare(`INSERT INTO settings (key, locale, value, updated_at) VALUES ('a', '', 'x', ?)`).run(now);
    expect(() => db.prepare(
      `INSERT INTO settings (key, locale, value, updated_at) VALUES ('a', '', 'y', ?)`,
    ).run(now)).toThrow();
  });
});

describe('textures', () => {
  it('hash 有意不加唯一约束（多行可共享同一 R2 对象）', () => {
    const insert = () => db.prepare(
      `INSERT INTO textures (hash, kind, model, name, size_bytes, visibility, width, height, created_at, updated_at)
       VALUES ('shared-hash', 'skin', 'default', ?, 100, 'public', 64, 64, ?, ?)`,
    ).run('N', now, now);
    insert();
    // 第二次插入必须成功 —— 旧库允许同哈希多行，加唯一约束会强制重映射 tid
    expect(insert).not.toThrow();
  });

  it('model 可为 NULL（披风没有模型）', () => {
    expect(() => db.prepare(
      `INSERT INTO textures (hash, kind, model, name, size_bytes, visibility, width, height, created_at, updated_at)
       VALUES ('cape-h', 'cape', NULL, 'C', 100, 'public', 64, 32, ?, ?)`,
    ).run(now, now)).not.toThrow();
  });
});

describe('外键与级联', () => {
  it('拒绝外键悬空的插入', () => {
    expect(() => db.prepare(
      `INSERT INTO players (user_id, name, updated_at) VALUES (999999, 'Ghost', ?)`,
    ).run(now)).toThrow(/FOREIGN KEY/i);
  });

  it('删除用户级联删除其玩家，并把纹理的 uploader 置空', () => {
    const uid = insertUser();
    db.prepare(`INSERT INTO players (user_id, name, updated_at) VALUES (?, 'Cascade', ?)`).run(uid, now);
    const tid = Number(db.prepare(
      `INSERT INTO textures (hash, kind, model, name, uploader_id, size_bytes, visibility, width, height, created_at, updated_at)
       VALUES ('cascade-h', 'skin', 'default', 'T', ?, 100, 'public', 64, 64, ?, ?)`,
    ).run(uid, now, now).lastInsertRowid);

    db.prepare('DELETE FROM users WHERE id = ?').run(uid);

    const players = db.prepare('SELECT COUNT(*) AS n FROM players WHERE user_id = ?').get(uid) as { n: number };
    expect(players.n).toBe(0);

    // 纹理**保留**并匿名化：删除用户不应销毁其他玩家正在使用的纹理
    const texture = db.prepare('SELECT uploader_id FROM textures WHERE id = ?').get(tid) as { uploader_id: number | null };
    expect(texture.uploader_id).toBeNull();
  });
});

describe('FTS5 全文搜索', () => {
  function insertTexture(name: string): number {
    return Number(db.prepare(
      `INSERT INTO textures (hash, kind, model, name, size_bytes, visibility, width, height, created_at, updated_at)
       VALUES (?, 'skin', 'default', ?, 100, 'public', 64, 64, ?, ?)`,
    ).run(`h-${Math.random()}`, name, now, now).lastInsertRowid);
  }

  const search = (q: string) => db.prepare(
    `SELECT t.id, t.name FROM textures_fts f JOIN textures t ON t.id = f.rowid
      WHERE textures_fts MATCH ? ORDER BY t.id`,
  ).all(q) as Array<{ id: number; name: string }>;

  it('插入时触发器同步索引', () => {
    insertTexture('dragon skin');
    expect(search('dragon').length).toBeGreaterThan(0);
  });

  it('支持子串匹配（trigram 分词器，对齐旧版的 LIKE %q%）', () => {
    insertTexture('verylongskinname');
    // 中间子串也能命中 —— unicode61 做不到这一点
    expect(search('longskin').length).toBeGreaterThan(0);
  });

  it('支持中文子串（unicode61 会把整串中文当成一个 token，所以必须用 trigram）', () => {
    insertTexture('我的蓝色披风');
    // 3 字及以上能命中
    expect(search('蓝色披').length).toBeGreaterThan(0);
    expect(search('蓝色披风').length).toBeGreaterThan(0);
  });

  it('trigram 的已知限制：2 字查询无法命中 MATCH，必须由应用层回退处理', () => {
    // 这条测试**有意锁住一个限制**，而不是断言理想行为。
    // trigram 以 3 字符为单位建索引，因此 2 个字的查询匹配不到任何 trigram。
    // 中文用户很自然会输入两个字（"蓝色"、"披风"），所以查询层必须对
    // 长度 < 3 的输入改走精确匹配/前缀匹配，而不是直接返回空结果。
    // 这就是 docs/rewrite/04-database-schema.md §4 里写的回退路径。
    insertTexture('我的蓝色披风');
    expect(search('蓝色')).toHaveLength(0);

    // 回退方案的效果：用 LIKE 精确/子串匹配能命中
    const fallback = db.prepare(
      `SELECT id FROM textures WHERE name LIKE '%' || ? || '%'`,
    ).all('蓝色') as Array<{ id: number }>;
    expect(fallback.length).toBeGreaterThan(0);
  });

  it('改名时触发器更新索引（旧名字不再命中）', () => {
    const id = insertTexture('oldname12345');
    expect(search('oldname').length).toBe(1);
    db.prepare('UPDATE textures SET name = ? WHERE id = ?').run('newname67890', id);
    expect(search('oldname').length).toBe(0);
    expect(search('newname').length).toBe(1);
  });

  it('删除时触发器清理索引', () => {
    const id = insertTexture('deleteme12345');
    expect(search('deleteme').length).toBe(1);
    db.prepare('DELETE FROM textures WHERE id = ?').run(id);
    expect(search('deleteme').length).toBe(0);
  });
});
