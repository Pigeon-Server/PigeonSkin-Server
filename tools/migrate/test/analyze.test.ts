// analyze 的契约测试。
//
// 这些测试断言的是"analyze 对一份已知脏数据的判定结果"。
// 它们是迁移工具最重要的一层保护：如果某个检查悄悄失效（比如 SQL 写错导致
// 查不出重复邮箱），这里会立刻失败，而不是等到切换当天才发现旧数据没被校验。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLegacyFixture, type FixtureManifest } from './fixtures/build-legacy.ts';
import { SqliteSource } from '../src/sources/sqlite.ts';
import { analyze } from '../src/commands/analyze.ts';
import { decideVerdict, summarize, type AnalyzeReport } from '../src/lib/report.ts';

let manifest: FixtureManifest;
let report: AnalyzeReport;

const codes = (r: AnalyzeReport, severity: 'blocker' | 'warning' | 'info') =>
  r.findings.filter((f) => f.severity === severity).map((f) => f.code);

const find = (r: AnalyzeReport, code: string) => r.findings.find((f) => f.code === code);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-migrate-fixture-'));
  manifest = buildLegacyFixture(dir);
  const source = new SqliteSource({ path: manifest.dbPath, readOnly: true });
  try {
    report = await analyze({
      source,
      texturesDir: manifest.texturesDir,
      pwdMethod: 'BCRYPT',
    });
  } finally {
    await source.close();
  }
});

afterAll(() => {
  rmSync(manifest.dir, { recursive: true, force: true });
});

describe('analyze — 行数', () => {
  it('列出未映射的非空旧表，避免静默遗漏数据', async () => {
    const dir=mkdtempSync(join(tmpdir(),'bs-unmapped-'));
    const fixture=buildLegacyFixture(dir);
    const database=new (process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(fixture.dbPath);
    database.exec("CREATE TABLE extra_records(id INTEGER PRIMARY KEY); INSERT INTO extra_records VALUES (1),(2)");database.close();
    const source=new SqliteSource({path:fixture.dbPath,readOnly:true});
    try {
      const result=await analyze({source,texturesDir:fixture.texturesDir,pwdMethod:'BCRYPT'});
      expect(result.tables.find(table=>table.name==='extra_records')).toMatchObject({rows:2,note:'unmapped'});
      expect(result.findings.find(item=>item.code==='unmapped-legacy-tables')).toMatchObject({severity:'warning',count:1,samples:['extra_records (2 行)']});
    }finally{await source.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('每张表的行数都与 fixture 一致', () => {
    for (const [table, n] of Object.entries(manifest.expected.counts)) {
      const status = report.tables.find((t) => t.name === table);
      expect(status, `表 ${table} 应出现在报告里`).toBeDefined();
      expect(status!.rows, `表 ${table} 行数`).toBe(n);
    }
  });

  it('报告里列出被有意丢弃的表，让运维知道它们不是被忘了', () => {
    for (const t of ['jobs', 'scopes']) {
      const status = report.tables.find((x) => x.name === t);
      expect(status?.note, `${t} 应标为 dropped`).toBe('dropped');
    }
  });
});

describe('analyze — 阻塞项', () => {
  it('检出全部阻塞项，且不多报', () => {
    expect(codes(report, 'blocker').sort()).toEqual([...manifest.expected.blockerCodes].sort());
  });

  it('空邮箱被判为阻塞项（新 schema 要求 email 唯一非空）', () => {
    const f = find(report, 'empty-email');
    expect(f?.severity).toBe('blocker');
    expect(f?.samples).toContain('uid=5');
  });

  it('不区分大小写的重复邮箱保留为待登录处理的冲突', () => {
    const f = find(report, 'duplicate-email');
    expect(f?.severity).toBe('warning');
    expect(f?.samples.join(' ')).toContain('a@example.com');
  });

  it('玩家名大小写冲突被判为阻塞项（不能静默改名）', () => {
    const f = find(report, 'player-name-case-collision');
    expect(f?.severity).toBe('blocker');
    expect(f?.samples.join(' ')).toContain('notch');
    expect(f?.remediation).toMatch(/人工/);
  });

  it('哈希不符被判为阻塞项，且明确不自动改写哈希', () => {
    const f = find(report, 'texture-hash-mismatch');
    expect(f?.severity).toBe('blocker');
    expect(f?.remediation).toMatch(/绝不自动改写/);
  });

  it('整份报告的结论是 blocked', () => {
    expect(report.verdict).toBe('blocked');
    expect(decideVerdict(report.findings)).toBe('blocked');
    expect(summarize(report).blockers.length).toBeGreaterThan(0);
  });
});

describe('analyze — 警告', () => {
  it('检出全部预期警告，且不多报', () => {
    expect(codes(report, 'warning').sort()).toEqual([...manifest.expected.warningCodes].sort());
  });

  it('缺失纹理文件被报告，并给出两种处理方式', () => {
    const f = find(report, 'texture-file-missing');
    expect(f?.severity).toBe('warning');
    expect(f?.remediation).toMatch(/--skip-missing/);
    expect(f?.remediation).toMatch(/503/);
  });

  it('孤儿文件被报告，且明确不会自动导入', () => {
    const f = find(report, 'orphan-texture-file');
    expect(f?.severity).toBe('warning');
    expect(f?.remediation).toMatch(/不自动导入/);
    expect(f?.remediation).toMatch(/--import-orphans/);
  });

  it('被有意丢弃的配置项会被逐一点名（避免运维以为配置丢了）', () => {
    const f = find(report, 'dropped-option-keys');
    expect(f?.count).toBe(manifest.expected.findingCounts['dropped-option-keys']);
    expect(f?.samples.join(' ')).toContain('version');
    expect(f?.samples.join(' ')).toContain('cdn_address');
  });

  it('未识别的配置项被保留而非丢弃', () => {
    const f = find(report, 'unknown-option-keys');
    expect(f?.samples.join(' ')).toContain('some_plugin_option');
    expect(f?.remediation).toMatch(/原样迁移/);
    expect(f?.remediation).toMatch(/不静默丢弃/);
  });

  it('重复收藏行与悬空收藏引用都被报告', () => {
    expect(find(report, 'duplicate-closet-rows')?.count).toBe(1);
    expect(find(report, 'dangling-closet-ref')?.count).toBe(1);
  });

  it('通知 data 结构异常被抽样报告', () => {
    const f = find(report, 'notification-data-shape');
    expect(f?.count).toBe(1);
    expect(f?.samples[0]).toContain('33333333');
  });
});

describe('analyze — 不应误报', () => {
  it('uploader=0 不当作孤儿引用（旧版用它表示已注销用户）', () => {
    expect(find(report, 'orphan-texture-uploader')).toBeUndefined();
  });

  it('tid_skin/tid_cape 为 0 或 -1 不当作孤儿引用（两者都表示"无"）', () => {
    // fixture 里 pid=4 是 -1、pid=5 是 0、pid=2 的 cape 是 0
    const f = find(report, 'orphan-player-texture-ref');
    expect(f?.count).toBe(1);          // 只有 pid=6 的 999999 才算
    expect(f?.samples.join(' ')).not.toContain('pid=4');
    expect(f?.samples.join(' ')).not.toContain('pid=5');
  });

  it('共享哈希只报为提示，不报为阻塞项或警告（新 schema 有意不加唯一约束）', () => {
    const f = find(report, 'duplicate-texture-hash');
    expect(f?.severity).toBe('info');
    expect(f?.count).toBe(manifest.expected.findingCounts['duplicate-texture-hash']);
    expect(f?.remediation).toMatch(/不加 hash 唯一约束/);
  });

  it('合法角色值不报未知角色', () => {
    expect(find(report, 'unknown-permission')).toBeUndefined();
  });

  it('合法纹理类型不报未知类型', () => {
    expect(find(report, 'unknown-texture-type')).toBeUndefined();
  });
});

describe('analyze — 提示项与计数', () => {
  it('全部预期提示项都在', () => {
    expect(codes(report, 'info').sort()).toEqual([...manifest.expected.infoCodes].sort());
  });

  it('各 finding 的计数与 fixture 契约一致', () => {
    for (const [code, n] of Object.entries(manifest.expected.findingCounts)) {
      expect(find(report, code)?.count, `${code} 的计数`).toBe(n);
    }
  });

  it('locale 别名被识别并给出归一化目标', () => {
    const f = find(report, 'locale-alias');
    expect(f?.samples.join(' ')).toContain('zh_HANS_CN→zh_CN');
    expect(f?.samples.join(' ')).toContain('en_US→en');
  });

  it('密码算法来自 PWD_METHOD 而非嗅探哈希字符串', () => {
    const f = find(report, 'password-algorithm');
    expect(f?.title).toContain('bcrypt');
    expect(f?.title).toContain('不需要 SALT');
  });

  it('选项键分类计数正确', () => {
    expect(report.counts['options.mapped']).toBe(manifest.expected.optionKeys.mapped);
    expect(report.counts['options.localized']).toBe(manifest.expected.optionKeys.localized);
    expect(report.counts['options.dropped']).toBe(manifest.expected.optionKeys.dropped);
    expect(report.counts['options.unknown']).toBe(manifest.expected.optionKeys.unknown);
  });
});

describe('analyze — 密码盐的阻塞逻辑', () => {
  it('SALTED2SHA256 缺 SALT 时报阻塞项，并说明后果', async () => {
    const source = new SqliteSource({ path: manifest.dbPath, readOnly: true });
    try {
      const r = await analyze({ source, pwdMethod: 'SALTED2SHA256', legacySalt: null });
      const f = find(r, 'legacy-salt-missing');
      expect(f?.severity).toBe('blocker');
      expect(f?.count).toBe(manifest.expected.counts['users']);
      expect(f?.remediation).toMatch(/强制重置/);
    } finally {
      await source.close();
    }
  });

  it('提供 SALT 后同样配置不再报阻塞项', async () => {
    const source = new SqliteSource({ path: manifest.dbPath, readOnly: true });
    try {
      const r = await analyze({ source, pwdMethod: 'SALTED2SHA256', legacySalt: 'sekrit' });
      expect(find(r, 'legacy-salt-missing')).toBeUndefined();
      expect(find(r, 'password-algorithm')?.title).toContain('需要 SALT，已提供');
    } finally {
      await source.close();
    }
  });

  it('未提供 PWD_METHOD 时只警告，不阻塞', async () => {
    const source = new SqliteSource({ path: manifest.dbPath, readOnly: true });
    try {
      const r = await analyze({ source });
      const f = find(r, 'pwd-method-missing');
      expect(f?.severity).toBe('warning');
    } finally {
      await source.close();
    }
  });

  it('无法识别的 PWD_METHOD 报阻塞项', async () => {
    const source = new SqliteSource({ path: manifest.dbPath, readOnly: true });
    try {
      const r = await analyze({ source, pwdMethod: 'SOMETHING_ELSE' });
      expect(find(r, 'unknown-pwd-method')?.severity).toBe('blocker');
    } finally {
      await source.close();
    }
  });
});

describe('analyze — 纹理文件对照', () => {
  it('文件统计与契约一致', () => {
    const f = find(report, 'texture-file-summary');
    expect(f).toBeDefined();
    const t = manifest.expected.textureFiles;
    expect(f!.title).toContain(`磁盘 ${t.onDiskTotal} 个`);
    expect(f!.title).toContain(`数据行 ${manifest.expected.counts['textures']} 条`);
    expect(f!.title).toContain(`缺失 ${t.missingRows}`);
    expect(f!.title).toContain(`哈希不符 ${t.hashMismatchRows}`);
    expect(f!.title).toContain(`孤儿 ${t.orphanFiles}`);
  });

  it('不给 --textures 时跳过文件检查（不报文件相关 finding）', async () => {
    const source = new SqliteSource({ path: manifest.dbPath, readOnly: true });
    try {
      const r = await analyze({ source, pwdMethod: 'BCRYPT' });
      expect(find(r, 'texture-file-summary')).toBeUndefined();
      expect(find(r, 'texture-hash-mismatch')).toBeUndefined();
      // 注意：哈希不符属于文件层检查，跳过文件检查后该阻塞项也就不存在了
      expect(codes(r, 'blocker')).not.toContain('texture-hash-mismatch');
    } finally {
      await source.close();
    }
  });

  it('--skip-file-hash 仍检查文件存在性，但不做哈希校验', async () => {
    const source = new SqliteSource({ path: manifest.dbPath, readOnly: true });
    try {
      const r = await analyze({
        source, texturesDir: manifest.texturesDir, pwdMethod: 'BCRYPT', skipFileHash: true,
      });
      expect(find(r, 'texture-file-missing')?.count).toBe(1);
      expect(find(r, 'texture-hash-mismatch')).toBeUndefined();
    } finally {
      await source.close();
    }
  });
});
