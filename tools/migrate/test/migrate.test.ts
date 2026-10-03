// migrate / verify 端到端测试 —— 对 fixture 的真实脏数据跑全流程。
//
// 断言的核心不是"数据进去了"，而是：
//   • 脏数据被正确处置（跳过/去重/置空），且每类处置都有计数
//   • ID 原值迁移（uid/pid/tid 一一对应）
//   • 旧哈希被包装为自描述格式，新库无裸哈希
//   • dry-run 不写任何行
//   • verify 能发现被人为破坏的状态
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildLegacyFixture, FIXTURE_TIMEZONE, type FixtureManifest } from './fixtures/build-legacy.ts';
import { SqliteSource } from '../src/sources/sqlite.ts';
import { SqliteTarget } from '../src/targets/types.ts';
import { migrate } from '../src/commands/migrate.ts';
import { verify } from '../src/commands/verify.ts';

// 新库 schema：packages/db/migrations 的全部 .sql 按文件名序拼接
const TEST_DIR = dirname(fileURLToPath(import.meta.url));      // tools/migrate/test
const MIGRATE_PKG = dirname(TEST_DIR);                          // tools/migrate
const TOOLS_DIR = dirname(MIGRATE_PKG);                         // tools
const REPO_ROOT = dirname(TOOLS_DIR);                           // 仓库根
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'migrations');

function loadNewSchemaSql(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).join('\n');
}

const NEW_SCHEMA_SQL = loadNewSchemaSql();

let workDir: string;
let fixture: FixtureManifest;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'bs-migrate-'));
  fixture = buildLegacyFixture(join(workDir, 'legacy'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('migrate（dry-run）', () => {
  let source: SqliteSource;
  let target: SqliteTarget;

  beforeEach(() => {
    source = new SqliteSource({ path: fixture.dbPath, readOnly: true });
    target = SqliteTarget.open(join(workDir, 'dry-run.sqlite'));
  });
  afterEach(() => { source.close(); target.close(); });

  it('全流程映射但不落库：users 计数正确、目标库无行', async () => {
    const result = await migrate({
      source, target, schemaSql: NEW_SCHEMA_SQL,
      texturesDir: fixture.texturesDir,
      pwdMethod: 'BCRYPT', timeZone: FIXTURE_TIMEZONE,
      dryRun: true,
    });

    const users = result.stages.find((s) => s.stage === 'users');
    expect(users?.total).toBe(fixture.expected.counts.users);
    expect(users?.written).toBe(0);

    const rows = await target.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS n FROM users`);
    expect(Number(rows[0]!['n'])).toBe(0);
  });
});

describe('migrate（真实写入）', () => {
  let source: SqliteSource;
  let target: SqliteTarget;
  let result: Awaited<ReturnType<typeof migrate>>;

  beforeAll(async () => {
    source = new SqliteSource({ path: fixture.dbPath, readOnly: true });
    target = SqliteTarget.open(join(workDir, 'real.sqlite'));
    result = await migrate({
      source, target, schemaSql: NEW_SCHEMA_SQL,
      texturesDir: fixture.texturesDir,
      pwdMethod: 'BCRYPT', timeZone: FIXTURE_TIMEZONE,
      batchSize: 3, // 强制多批，覆盖分批路径
    });
  });
  afterAll(() => { source.close(); target.close(); });

  it('users：保留重复邮箱账号，角色映射正确', async () => {
    const stage = result.stages.find((s) => s.stage === 'users')!;
    expect(stage.total).toBe(10);
    expect(stage.written).toBe(9);
    const conflicts = await target.query<{ id: number; legacy_email_conflict: number }>(`SELECT id, legacy_email_conflict FROM users WHERE id IN (6,7)`);
    expect(conflicts).toEqual([{ id: 6, legacy_email_conflict: 1 }, { id: 7, legacy_email_conflict: 1 }]);
    expect(stage.skipped['empty-email']).toBe(1);

    const admin = await target.query<{ role: string }>(
      `SELECT role FROM users WHERE id = 1`);
    expect(admin[0]!.role).toBe('super_admin');
    const banned = await target.query<{ role: string }>(
      `SELECT role FROM users WHERE id = 3`);
    expect(banned[0]!.role).toBe('banned');
    const normal = await target.query<{ role: string }>(
      `SELECT role FROM users WHERE id = 2`);
    expect(normal[0]!.role).toBe('normal');
  });

  it('迁移完成后没有悬空外键', async () => {
    expect(await target.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('users：locale 别名归一化', async () => {
    const u2 = await target.query<{ locale: string | null }>(
      `SELECT locale FROM users WHERE id = 2`);
    expect(u2[0]!.locale).toBe('zh_CN');
    const u4 = await target.query<{ locale: string | null }>(
      `SELECT locale FROM users WHERE id = 4`);
    expect(u4[0]!.locale).toBe('en');
  });

  it('users：密码哈希是自描述格式，没有裸哈希', async () => {
    const rows = await target.query<{ password_hash: string }>(
      `SELECT password_hash FROM users`);
    for (const r of rows) {
      expect(r.password_hash).toMatch(/^[a-z0-9_]+:/);
    }
  });

  it('users：email 验证时间 = 注册时间；签到哨兵被清掉', async () => {
    const u1 = await target.query<{
      email_verified_at: number | null; created_at: number; last_sign_at: number | null;
    }>(`SELECT email_verified_at, created_at, last_sign_at FROM users WHERE id = 1`);
    expect(u1[0]!.email_verified_at).toBe(u1[0]!.created_at);
    // uid=1 的 last_sign_at 是注册前一天（从未签到的哨兵）→ 应为 NULL
    expect(u1[0]!.last_sign_at).toBeNull();
    // uid=8 真签过到 → 保留
    const u8 = await target.query<{ last_sign_at: number | null }>(
      `SELECT last_sign_at FROM users WHERE id = 8`);
    expect(u8[0]!.last_sign_at).not.toBeNull();
  });

  it('textures：10 写入（跳过 1 缺文件），kind/model 映射正确', async () => {
    const stage = result.stages.find((s) => s.stage === 'textures')!;
    expect(stage.total).toBe(11);
    expect(stage.written).toBe(10);
    expect(stage.skipped['texture-file-missing']).toBe(1);

    const alex = await target.query<{ kind: string; model: string | null }>(
      `SELECT kind, model FROM textures WHERE id = 3`);
    expect(alex[0]!.kind).toBe('skin');
    expect(alex[0]!.model).toBe('slim');
    const cape = await target.query<{ kind: string; model: string | null }>(
      `SELECT kind, model FROM textures WHERE id = 4`);
    expect(cape[0]!.kind).toBe('cape');
    expect(cape[0]!.model).toBeNull();
  });

  it('textures：size KB → 字节；uploader=0 → NULL', async () => {
    const t = await target.query<{
      size_bytes: number; uploader_id: number | null; visibility: string;
    }>(`SELECT size_bytes, uploader_id, visibility FROM textures WHERE id = 1`);
    expect(t[0]!.size_bytes).toBeGreaterThan(0);
    expect(t[0]!.size_bytes % 1024).toBe(0);
    expect(t[0]!.uploader_id).toBe(1);
    const anon = await target.query<{ uploader_id: number | null }>(
      `SELECT uploader_id FROM textures WHERE id = 11`);
    expect(anon[0]!.uploader_id).toBeNull();
  });

  it('players：跳过无效用户和大小写冲突；悬空引用与 -1/0 置 NULL', async () => {
    const stage = result.stages.find((s) => s.stage === 'players')!;
    // pid=3 "notch" 与 pid=2 "Notch" 仅大小写不同 → NOCASE 唯一索引丢弃（analyze 判 blocker）
    expect(stage.written).toBe(5);
    expect(stage.skipped['dangling-user']).toBe(1);

    const noSkin = await target.query<{ skin_texture_id: number | null }>(
      `SELECT skin_texture_id FROM players WHERE id = 4`);
    expect(noSkin[0]!.skin_texture_id).toBeNull();
    const dangling = await target.query<{ skin_texture_id: number | null }>(
      `SELECT skin_texture_id FROM players WHERE id = 6`);
    expect(dangling).toEqual([]);
    const caped = await target.query<{
      skin_texture_id: number | null; cape_texture_id: number | null;
    }>(`SELECT skin_texture_id, cape_texture_id FROM players WHERE id = 7`);
    expect(caped[0]!.skin_texture_id).toBe(5);
    expect(caped[0]!.cape_texture_id).toBe(4);
  });

  it('closet：3 有效条目（去重 1、悬空纹理 1）', async () => {
    const stage = result.stages.find((s) => s.stage === 'closet')!;
    expect(stage.total).toBe(5);
    expect(stage.written).toBe(3);
    expect(stage.skipped['duplicate']).toBe(1);
    expect(stage.skipped['dangling-texture']).toBe(1);
  });

  it('reports：2 有效（去重 1、悬空纹理 1），状态映射正确', async () => {
    const stage = result.stages.find((s) => s.stage === 'reports')!;
    expect(stage.total).toBe(4);
    expect(stage.written).toBe(2);
    expect(stage.skipped['duplicate']).toBe(1);
    expect(stage.skipped['dangling-texture']).toBe(1);

    const pending = await target.query<{ status: string }>(
      `SELECT status FROM reports WHERE id = 1`);
    expect(pending[0]!.status).toBe('pending');
    const resolved = await target.query<{ status: string; reviewed_at: number | null }>(
      `SELECT status, reviewed_at FROM reports WHERE id = 3`);
    expect(resolved[0]!.status).toBe('resolved');
    expect(resolved[0]!.reviewed_at).not.toBeNull();
  });

  it('notifications：3 全量，{title,content} 拆成两列，坏结构用占位标题', async () => {
    const stage = result.stages.find((s) => s.stage === 'notifications')!;
    expect(stage.written).toBe(3);

    const n1 = await target.query<{ title: string; body: string | null }>(
      `SELECT title, body FROM notifications WHERE user_id = 1`);
    expect(n1[0]!.title).toBe('欢迎');
    expect(n1[0]!.body).toBe('**你好**');
    const n3 = await target.query<{ title: string }>(
      `SELECT title FROM notifications WHERE user_id = 3`);
    expect(n3[0]!.title).toContain('无法解析');
  });

  it('notifications：已读时间正确迁移', async () => {
    const read = await target.query<{ read_at: number | null }>(
      `SELECT read_at FROM notifications WHERE user_id = 2`);
    expect(read[0]!.read_at).not.toBeNull();
  });

  it('settings：sign_score 拆成 min/max；regs_per_ip=3 带开关注入', async () => {
    const stage = result.stages.find((s) => s.stage === 'settings')!;
    expect(stage.written).toBeGreaterThan(20);

    const min = await target.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'sign_score_min' AND locale = ''`);
    expect(min[0]!.value).toBe('10');
    const max = await target.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'sign_score_max' AND locale = ''`);
    expect(max[0]!.value).toBe('100');

    const enabled = await target.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'registration_enabled' AND locale = ''`);
    expect(enabled[0]!.value).toBe('true');
  });

  it('settings：本地化变体进对应 locale 行', async () => {
    const en = await target.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'site_name' AND locale = 'en'`);
    expect(en[0]!.value).toBe('Test Skin Server');
    const zh = await target.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'site_name' AND locale = 'zh_CN'`);
    expect(zh[0]!.value).toBe('测试皮肤站');
  });

  it('settings：score_per_storage="true" 的历史坏值被矫正为 1', async () => {
    const v = await target.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'score_per_kb_public' AND locale = ''`);
    expect(v[0]!.value).toBe('1');
  });

  it('settings：hide_intro 反转为 home_show_intro', async () => {
    const v = await target.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'home_show_intro' AND locale = ''`);
    expect(v[0]!.value).toBe('false'); // 旧 hide_intro=true → show=false
  });

  it('settings：未知插件键原样保留', async () => {
    const v = await target.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'some_plugin_option' AND locale = ''`);
    expect(v[0]!.value).toBe('未知插件留下的配置');
  });

  it('R2 清单：唯一哈希数正确，键名形如 textures/<hash>.png', () => {
    // 磁盘上被引用的唯一哈希 7 个：h1(tid1/10)、h2(tid2/11)、h3、h4、
    // h5、hDup(tid6/7)、hMismatch(tid9)。tid8 缺文件不在清单；孤儿文件不迁。
    expect(result.r2Objects.size).toBe(7);
    for (const key of result.r2Objects.keys()) {
      expect(key).toMatch(/^textures\/[0-9a-f]{64}\.png$/);
    }
  });

  it('时间戳：旧库上海时间 2023-01-15 10:30 → UTC epoch', async () => {
    const u1 = await target.query<{ created_at: number }>(
      `SELECT created_at FROM users WHERE id = 1`);
    expect(u1[0]!.created_at).toBe(Date.UTC(2023, 0, 15, 2, 30, 0));
  });
});

describe('verify', () => {
  it('通知使用 UTC，用户日期继续按旧站时区解释', async () => {
    const source=new SqliteSource({path:fixture.dbPath,readOnly:true});
    const target=SqliteTarget.open(join(workDir,'utc-notifications.sqlite'));
    try {
      await migrate({source,target,schemaSql:NEW_SCHEMA_SQL,texturesDir:fixture.texturesDir,pwdMethod:'BCRYPT',timeZone:FIXTURE_TIMEZONE,notificationTimeZone:'UTC'});
      const notifications=await target.query<{created_at:number}>('SELECT created_at FROM notifications WHERE user_id = 1');
      expect(notifications[0]!.created_at).toBe(Date.UTC(2023,1,14,10,30));
      const users=await target.query<{created_at:number}>('SELECT created_at FROM users WHERE id = 1');
      expect(users[0]!.created_at).toBe(Date.UTC(2023,0,15,2,30));
    }finally{await source.close();await target.close();}
  });
  it('拒绝包含无效外键的目标数据', async () => {
    const target=SqliteTarget.open(join(workDir,'invalid-foreign-key.sqlite'));
    const source=new SqliteSource({path:fixture.dbPath,readOnly:true});
    try {
      await target.applySchema(NEW_SCHEMA_SQL);
      await target.runBatch([{sql:'INSERT INTO notifications(user_id,type,title,created_at) VALUES (?,?,?,?)',params:[99999,'test','Invalid',Date.now()]}]);
      const result=await verify({newDb:target,legacyDb:source,legacyCounts:{},stageSkipped:{},r2Objects:new Map()});
      expect(result.ok).toBe(false);
      expect(result.findings.some(finding=>finding.code==='foreign-key-violations')).toBe(true);
    }finally{await target.close();await source.close();}
  });
  it('迁移后校验通过（含已知跳过的放宽）', async () => {
    const source = new SqliteSource({ path: fixture.dbPath, readOnly: true });
    const target = SqliteTarget.open(join(workDir, 'real.sqlite'));
    try {
      const result = await verify({
        legacyCounts: {
          users: 10, textures: 11, players: 7, user_closet: 5, reports: 4,
        },
        stageSkipped: {
          users: { 'empty-email': 1 },
          players: { 'dangling-user': 1 },
          textures: { 'texture-file-missing': 1 },
          closet: { duplicate: 1, 'dangling-texture': 1 },
          reports: { duplicate: 1, 'dangling-texture': 1 },
        },
        newDb: target,
        legacyDb: source,
        r2Objects: new Map(),
      });
      expect(result.ok).toBe(true);
      expect(result.checks.every((c) => c.passed)).toBe(true);
      expect(result.findings).toHaveLength(0);
    } finally {
      source.close();
      target.close();
    }
  });

  it('能发现 ID 缺失（模拟丢行）', async () => {
    const source = new SqliteSource({ path: fixture.dbPath, readOnly: true });
    const target = SqliteTarget.open(join(workDir, 'broken.sqlite'));
    await migrate({
      source, target, schemaSql: NEW_SCHEMA_SQL,
      texturesDir: fixture.texturesDir,
      pwdMethod: 'BCRYPT', timeZone: FIXTURE_TIMEZONE,
    });
    await target.runBatch([{
      sql: `DELETE FROM players WHERE id = 1`,
      params: [],
    }]);
    try {
      const result = await verify({
        legacyCounts: {
          users: 10, textures: 11, players: 7, user_closet: 5, reports: 4,
        },
        stageSkipped: {
          users: { 'empty-email': 1 },
          textures: { 'texture-file-missing': 1 },
          closet: { duplicate: 1, 'dangling-texture': 1 },
          reports: { duplicate: 1, 'dangling-texture': 1 },
        },
        newDb: target,
        legacyDb: source,
        r2Objects: new Map(),
      });
      expect(result.ok).toBe(false);
      expect(result.findings.some((f) => f.code === 'missing-player-ids')).toBe(true);
    } finally {
      source.close();
      target.close();
    }
  });
});
