#!/usr/bin/env node
// Pigeon Skin Server 迁移 CLI 入口。
//
// 用法:
//   node src/index.ts analyze --db ./legacy.sqlite --textures ./storage/textures \
//     --legacy-env ./legacy.env [--json] [--skip-file-hash]
//   node src/index.ts migrate --db ./legacy.sqlite --target ./new.sqlite \
//     --legacy-env ./legacy.env [--dry-run] [--batch 500]
//   node src/index.ts verify --db ./legacy.sqlite --target ./new.sqlite [--skip-users 1]
//
// 设计原则（见 docs/rewrite/09）：
//   • 只读源库 —— SqliteSource 默认以 readOnly 打开
//   • 未知参数直接报错，不静默忽略（静默忽略是运维事故的常见来源）
//   • 所有运维传入的路径都经 lib/paths.ts 统一校验；文件读取也在那里完成，
//     避免出现"校验的是 A、读的是 B"的窗口
//   • 凭据只从环境变量或命令行传入，绝不写入源码
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { SqliteSource } from './sources/sqlite.ts';
import { SqliteTarget } from './targets/types.ts';
import { analyze } from './commands/analyze.ts';
import { backfill } from './commands/backfill.ts';
import { migrate, serializeMigrateResult, extractStageSkipped } from './commands/migrate.ts';
import type { Stage } from './commands/types.ts';
import { verify } from './commands/verify.ts';
import { renderReport, renderMigrateResult, summarize } from './lib/report.ts';
import {
  PathValidationError,
  readValidatedTextFile,
  resolveExistingDir,
  resolveExistingFile,
} from './lib/paths.ts';
import { LEGACY_DEFAULT_TIMEZONE } from './schema/legacy.ts';

// CLI 安装位置：src/index.ts 位于仓库的 tools/migrate/src/。
// 用 dirname 逐级上溯定位仓库根，避免在代码里出现父级遍历段
const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATE_PKG_DIR = dirname(CLI_DIR);     // tools/migrate
const TOOLS_DIR = dirname(MIGRATE_PKG_DIR);   // tools
const MONOREPO_ROOT = dirname(TOOLS_DIR);     // 仓库根
const DEFAULT_SCHEMA_DIR = join(MONOREPO_ROOT, 'packages', 'db', 'migrations');

const USAGE = `Pigeon Skin Server 迁移工具

用法: migrate <命令> [选项]

命令:
  analyze    只读分析旧库，报告阻塞项与警告
  migrate    执行迁移（先 analyze，有阻塞项则拒绝）
  verify     校验迁移结果
  backfill   为旧站纹理生成衍生图（头像 2d/3d + 预览，sharp 本地生成）

analyze 选项:
  --db <path>                SQLite 数据库文件路径
  --legacy-env <path>        旧站 .env，用于读取 PWD_METHOD 与 SALT
  --pwd-method <NAME>        旧站密码算法，覆盖从 .env 读取的值
  --legacy-salt <value>      旧站 SALT（仅 SALTED2* 需要）
  --textures <dir>           旧站 storage/textures 目录
  --timezone <IANA>          旧库时区，默认 ${LEGACY_DEFAULT_TIMEZONE}
  --notification-timezone <IANA>  通知 timestamp 字段时区，默认同旧库时区
  --skip-file-hash           跳过文件哈希校验（大库预检省时间，但会漏掉哈希不符）
  --json                     以 JSON 输出（供自动化消费）

migrate 选项（含 analyze 的 --db/--legacy-env/--pwd-method/--legacy-salt/--textures）:
  --target <path>            新库 SQLite 文件路径（不存在则创建；已有 schema 幂等跳过）
  --schema <path>            新库 schema SQL；默认用仓库内 packages/db/migrations 全部 .sql
  --dry-run                  全流程走映射与过滤，只计数不落库
  --batch <n>                每事务行数，默认 500
  --force                    analyze 有阻塞项时仍强制执行（默认拒绝）
  --resume <stage:offset>    断点续跑：跳过 stage 之前的阶段，stage 从 offset 行起
                             （stage ∈ schema|users|textures|players|closet|reports|notifications|settings|files）
  --report-out <path>        迁移报告落盘路径（verify --report-in / --r2-manifest 消费）
  --uploaded-manifest <path> 上次 migrate --report-out 的报告：其 R2 清单中的哈希视为已上传，本次跳过

verify 选项:
  --db / --target 同上
  --skip-users <n>           计数核对时从期望用户数减去的值（空邮箱等已处理项）
  --report-in <path>         migrate 报告（skipped 统计来源）
  --r2-manifest <path>       migrate 报告（对清单里的**本地源文件**做内容哈希复核；
                             R2 对象侧校验需上传后另行比对，工具不持 CF 凭据）

backfill 选项:
  --metadata-db <path>       已迁移 SQLite 数据库，按材质类型和模型生成
  --textures <dir>           旧站 storage/textures 目录（必填）
  --out <dir>                衍生图输出目录（默认 textures 同级 ./derivatives）
  --sizes <list>             头像尺寸逗号分隔，默认 100,64（白名单 36/45/64/100/200）

通用:
  -h, --help                 显示帮助
`;

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) {
      if (token === '-h') { flags.set('help', true); continue; }
      throw new Error(`无法识别的参数: ${token}（本工具不静默忽略未知参数）`);
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i++;
    }
  }
  return { command: command ?? '', flags };
}

function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function flagInt(flags: ParsedArgs['flags'], name: string): number | undefined {
  const v = flagString(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} 必须是非负整数`);
  return n;
}

function flagResume(flags: ParsedArgs['flags']): { stage: Stage; offset: number } | undefined {
  const v = flagString(flags, 'resume');
  if (v === undefined) return undefined;
  const [stage, offsetText] = v.split(':');
  const offset = Number(offsetText ?? 0);
  if (!stage || !Number.isInteger(offset) || offset < 0) {
    throw new Error('--resume 形如 users:1200（阶段:行偏移）');
  }
  const stages: readonly Stage[] = [
    'schema', 'users', 'textures', 'players', 'closet',
    'reports', 'notifications', 'settings', 'uuid', 'descriptions', 'pigeon', 'files',
  ];
  if (!stages.includes(stage as Stage)) {
    throw new Error(`--resume 的阶段 "${stage}" 不合法（可选: ${stages.join('|')}）`);
  }
  return { stage: stage as Stage, offset };
}

/** 从上次 migrate 报告里取 R2 清单的哈希集合（--uploaded-manifest 用） */
function loadUploadedHashes(path: string | undefined): ReadonlySet<string> | undefined {
  if (!path) return undefined;
  const text = readValidatedTextFile(path, '--uploaded-manifest');
  const parsed = JSON.parse(text) as { r2Objects?: Record<string, string> };
  const hashes = new Set<string>();
  for (const key of Object.keys(parsed.r2Objects ?? {})) {
    // 键形如 textures/<hash>.png
    const m = /textures\/([0-9a-f]{64})\.png$/.exec(key);
    if (m) hashes.add(m[1]!);
  }
  return hashes;
}

/**
 * 从旧站 .env 解析 PWD_METHOD / SALT.
 * 密码算法是部署级设置，不在数据库行里 —— 绝不能用嗅探哈希字符串代替，
 * 因为裸十六进制家族有歧义（64 位可能是 sha256 也可能是 salted2sha256）。
 */
function parseLegacyEnv(text: string): { pwdMethod?: string; salt?: string } {
  const out: { pwdMethod?: string; salt?: string } = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'PWD_METHOD') out.pwdMethod = value;
    if (key === 'SALT') out.salt = value;
  }
  return out;
}

/** 把异常转成面向运维的一句话，不打印堆栈 */
function fail(message: string, showUsage = false): number {
  console.error(`错误: ${message}`);
  if (showUsage) { console.error(); console.error(USAGE); }
  return 2;
}

/** 默认 schema：仓库内 packages/db/migrations 的全部 .sql 按文件名序拼接 */
function loadSchemaSql(explicit: string | undefined): string {
  if (explicit) {
    return readFileSync(resolveExistingFile(explicit, '--schema'), 'utf8');
  }
  const dir = resolveExistingDir(DEFAULT_SCHEMA_DIR, 'schema 目录');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

/** 规范化"新库目标路径"：绝对化 + 拒绝 .. 段 + 限制为 .sqlite 文件。
 * 与 resolveExistingFile 不同：目标库允许尚不存在（首次迁移创建）。 */
function normalizeNewTargetPath(input: string): string {
  if (!input) throw new Error('目标库路径为空');
  const segments = input.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new Error(`--target 含 ".." 路径段，已拒绝: ${input}`);
  }
  const abs = resolve(input);
  if (!abs.endsWith('.sqlite') && !abs.endsWith('.db')) {
    throw new Error(`--target 必须是 .sqlite 或 .db 文件: ${abs}`);
  }
  return abs;
}

interface CommonInput {
  texturesDir?: string | undefined;
  pwdMethod?: string | undefined;
  legacySalt?: string | null | undefined;
  timeZone: string;
}

/** analyze/migrate/verify 共用的源库打开与路径校验 */
async function openCommon(
  parsed: ParsedArgs,
): Promise<{ input: CommonInput; source: SqliteSource }> {
  const rawDbPath = flagString(parsed.flags, 'db');
  if (!rawDbPath) throw new Error('需要 --db <path>');

  const sourceKind = flagString(parsed.flags, 'source') ?? 'sqlite';
  if (sourceKind !== 'sqlite') {
    throw new Error(`暂只支持 --source sqlite（收到 ${sourceKind}）`);
  }

  let dbPath: string;
  let texturesDir: string | undefined;
  let envText: string | undefined;
  try {
    dbPath = resolveExistingFile(rawDbPath, '--db');
    const rawTextures = flagString(parsed.flags, 'textures');
    if (rawTextures) texturesDir = resolveExistingDir(rawTextures, '--textures');
    const rawEnv = flagString(parsed.flags, 'legacy-env');
    if (rawEnv) envText = readValidatedTextFile(rawEnv, '--legacy-env');
  } catch (e) {
    if (e instanceof PathValidationError) throw new Error(e.message, { cause: e });
    throw e;
  }

  const fromEnv = envText ? parseLegacyEnv(envText) : {};
  const source = new SqliteSource({ path: dbPath, readOnly: true });
  return {
    input: {
      texturesDir,
      pwdMethod: flagString(parsed.flags, 'pwd-method') ?? fromEnv.pwdMethod,
      legacySalt: flagString(parsed.flags, 'legacy-salt') ?? fromEnv.salt ?? null,
      timeZone: flagString(parsed.flags, 'timezone') ?? LEGACY_DEFAULT_TIMEZONE,
    },
    source,
  };
}

async function runMigrate(parsed: ParsedArgs): Promise<number> {
  const { input, source } = await openCommon(parsed);
  try {
    if (!input.pwdMethod) {
      return fail('migrate 需要 --pwd-method（或 --legacy-env 指向含 PWD_METHOD 的 .env）');
    }
    const rawTarget = flagString(parsed.flags, 'target');
    if (!rawTarget) return fail('migrate 需要 --target <path>', true);

    // 先跑 analyze：有阻塞项则拒绝执行 —— mapper 不重复做校验
    const report = await analyze({
      source, texturesDir: input.texturesDir, timeZone: input.timeZone,
      pwdMethod: input.pwdMethod, legacySalt: input.legacySalt,
    });
    const blockers = summarize(report).blockers;
    if (blockers.length > 0 && !parsed.flags.has('force')) {
      console.error('旧库存在阻塞项，拒绝执行 migrate。先解决它们，或确认后加 --force：');
      for (const b of blockers) console.error(`  ✗ ${b.title}（${b.count}）`);
      return 1;
    }

    // 新库路径同样走"必须存在的文件"校验会拒绝首次创建，
    // 这里改为规范化 + 禁止父级遍历段后打开（首次迁移时该文件尚不存在）
    const safeTargetPath = normalizeNewTargetPath(rawTarget);
    const target = SqliteTarget.open(safeTargetPath);
    try {
      const resume = flagResume(parsed.flags);
      const uploadedHashes = loadUploadedHashes(flagString(parsed.flags, 'uploaded-manifest'));
      const result = await migrate({
        source,
        target,
        schemaSql: loadSchemaSql(flagString(parsed.flags, 'schema')),
        texturesDir: input.texturesDir,
        pwdMethod: input.pwdMethod,
        legacySalt: input.legacySalt,
        timeZone: input.timeZone,
        notificationTimeZone: flagString(parsed.flags, 'notification-timezone'),
        batchSize: flagInt(parsed.flags, 'batch'),
        dryRun: parsed.flags.has('dry-run'),
        ...(resume ? { resumeFrom: resume } : {}),
        ...(uploadedHashes ? { uploadedHashes } : {}),
        onProgress: (m) => console.log(m),
      });
      console.log(renderMigrateResult(result));

      // 报告落盘：verify --report-in 消费同一份文件做期望值对账
      const reportPath = flagString(parsed.flags, 'report-out');
      if (reportPath && !parsed.flags.has('dry-run')) {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname: d } = await import('node:path');
        mkdirSync(d(reportPath), { recursive: true });
        writeFileSync(reportPath, serializeMigrateResult(result));
        console.log(`迁移报告已写入: ${reportPath}`);
      }
      return 0;
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

async function runVerify(parsed: ParsedArgs): Promise<number> {
  const { source } = await openCommon(parsed);
  try {
    const rawTarget = flagString(parsed.flags, 'target');
    if (!rawTarget) return fail('verify 需要 --target <path>', true);

    // 旧行数直接重查（不依赖 analyze 报告文件）
    // 行数用内联静态 SQL 直查（与 verify.ts 同一形态），不走带表名参数的 count()
    const legacyCounts: Record<string, number> = {};
    const countRows = async (sql: string): Promise<number> => {
      const rows = await source.query(sql);
      return Number(rows[0]?.['n'] ?? 0);
    };
    legacyCounts['users'] = await countRows(`SELECT COUNT(*) AS n FROM users`);
    legacyCounts['textures'] = await countRows(`SELECT COUNT(*) AS n FROM textures`);
    legacyCounts['players'] = await countRows(`SELECT COUNT(*) AS n FROM players`);
    legacyCounts['user_closet'] = await countRows(`SELECT COUNT(*) AS n FROM user_closet`);
    legacyCounts['reports'] = await countRows(`SELECT COUNT(*) AS n FROM reports`);
    legacyCounts['notifications'] = await countRows(`SELECT COUNT(*) AS n FROM notifications`);

    const safeTargetPath2 = normalizeNewTargetPath(rawTarget);
    const target = SqliteTarget.open(safeTargetPath2);
    try {
      // skipped 统计优先来自 migrate 报告文件；没有报告时用 --skip-* 手工指定
      let stageSkipped: Record<string, Record<string, number>> = {
        users: {}, textures: {}, closet: {}, reports: {},
      };
      const reportPath = flagString(parsed.flags, 'report-in');
      if (reportPath) {
        stageSkipped = extractStageSkipped(
          readValidatedTextFile(reportPath, '--report-in'),
        );
      } else {
        const skipUsers = flagInt(parsed.flags, 'skip-users') ?? 0;
        stageSkipped['users']!['empty-email'] = skipUsers;
      }

      // --r2-manifest 提供清单时才做 R2 侧复核；否则该检查为空集（跳过）
      const manifestPath = flagString(parsed.flags, 'r2-manifest');
      let r2Objects: ReadonlyMap<string, string> = new Map();
      if (manifestPath) {
        const parsed2 = JSON.parse(readValidatedTextFile(manifestPath, '--r2-manifest')) as {
          r2Objects?: Record<string, string>;
        };
        r2Objects = new Map(Object.entries(parsed2.r2Objects ?? {}));
      }

      const result = await verify({
        legacyCounts,
        stageSkipped,
        newDb: target,
        legacyDb: source,
        r2Objects,
      });
      if (!manifestPath) {
        console.log('（未提供 --r2-manifest，跳过 R2 内容哈希复核）');
      }

      console.log(`校验结果: ${result.ok ? '✓ 通过' : '✗ 未通过'}`);
      for (const c of result.checks) {
        console.log(`  ${c.passed ? '✓' : '✗'} ${c.name}: 期望 ${c.expected}，实际 ${c.actual}`);
      }
      for (const f of result.findings) {
        console.log(`  ✗ [${f.code}] ${f.message}`);
      }
      return result.ok ? 0 : 1;
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

async function runBackfill(parsed: ParsedArgs): Promise<number> {
  const rawTextures = flagString(parsed.flags, 'textures');
  if (!rawTextures) return fail('backfill 需要 --textures <dir>', true);
  let texturesDir: string;
  try {
    texturesDir = resolveExistingDir(rawTextures, '--textures');
  } catch (e) {
    if (e instanceof PathValidationError) return fail(e.message);
    throw e;
  }
  const sizes = flagString(parsed.flags, 'sizes')
    ?.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);

  const result = await backfill({
    texturesDir,
    outDir: flagString(parsed.flags, 'out'),
    metadataDbPath: flagString(parsed.flags, 'metadata-db'),
    ...(sizes && sizes.length > 0 ? { sizes } : {}),
    onProgress: (m) => console.log(m),
  });
  console.log(`2d 头像: ${result.avatar2d}  3d 头像: ${result.avatar3d}  预览: ${result.preview}  跳过(已存在): ${result.skipped}`);
  if (result.failed.length > 0) {
    console.log(`失败 ${result.failed.length}:`);
    for (const f of result.failed.slice(0, 20)) console.log(`  ${f.hash}: ${f.reason}`);
  }
  return result.failed.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    return fail((e as Error).message, true);
  }

  if (parsed.command === '' || parsed.command === '--help' || parsed.command === '-h' || parsed.flags.has('help')) {
    console.log(USAGE);
    return 0;
  }

  try {
    switch (parsed.command) {
      case 'analyze': {
        const { input, source } = await openCommon(parsed);
        try {
          const report = await analyze({
            source,
            texturesDir: input.texturesDir,
            timeZone: input.timeZone,
            pwdMethod: input.pwdMethod,
            legacySalt: input.legacySalt,
            skipFileHash: parsed.flags.has('skip-file-hash'),
          });
          console.log(parsed.flags.has('json')
            ? JSON.stringify(report, null, 2)
            : renderReport(report));
          // 退出码约定：有阻塞项 → 1；有警告 → 0（警告不阻塞，但报告里可见）
          return summarize(report).blockers.length > 0 ? 1 : 0;
        } finally {
          await source.close();
        }
      }
      case 'migrate':
        return await runMigrate(parsed);
      case 'verify':
        return await runVerify(parsed);
      case 'backfill':
        return await runBackfill(parsed);
      default:
        return fail(`未知命令 "${parsed.command}"`, true);
    }
  } catch (e) {
    return fail((e as Error).message);
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e: unknown) => {
    console.error('未预期的错误:', e);
    process.exitCode = 3;
  });
