// 迁移阶段编排器：阶段顺序、断点续跑、R2 文件清单。
//
// 各阶段的实现委托给 stages-core / stages-social；本文件只负责
// 按依赖顺序调用与汇总统计，自身不做任何数据访问。
import type { SourceAdapter } from '../sources/types.ts';
import type { TargetAdapter } from '../targets/types.ts';
import { scanTextureDir, planR2Objects } from '../lib/textures.ts';
import {
  ALGOS_REQUIRING_LEGACY_SALT, LEGACY_DEFAULT_TIMEZONE, PWD_METHOD_TO_ALGO,
  type LegacyPasswordAlgo,
} from '../schema/legacy.ts';
import { stageUsers, stageTextures } from './stages-core.ts';
import { stagePigeon } from './stages-pigeon.ts';
import {
  stagePlayers, stageCloset, stageReports, stageNotifications, stageSettings,
  stageUuid, stageDescriptions,
} from './stages-social.ts';
import type { Stage, StageResult } from './types.ts';

export const MIGRATE_LOCALES = ['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU'];
export const DEFAULT_BATCH_SIZE = 500;

export interface MigrateOptions {
  readonly source: SourceAdapter;
  readonly target: TargetAdapter;
  /** 新库 schema 的 SQL 脚本（packages/db/migrations 拼接后的静态文本） */
  readonly schemaSql: string;
  /** 旧站 storage/textures 目录；不给则文件清单为空 */
  readonly texturesDir?: string | undefined;
  /** 密码算法（必填，来自旧站 .env 的 PWD_METHOD）；SALT 视算法而定 */
  readonly pwdMethod: string;
  readonly legacySalt?: string | null | undefined;
  readonly timeZone?: string;
  readonly notificationTimeZone?: string | undefined;
  readonly batchSize?: number | undefined;
  readonly dryRun?: boolean;
  /** 断点续跑：从这个阶段的这个行偏移继续 */
  readonly resumeFrom?: { stage: Stage; offset: number };
  /** R2 已上传过的哈希集合（跳过重复上传） */
  readonly uploadedHashes?: ReadonlySet<string>;
  readonly onProgress?: ((msg: string) => void) | undefined;
}

export interface MigrateResult {
  readonly stages: readonly StageResult[];
  /** R2 键 → 本地源文件路径（真上传由 wrangler r2 object put 执行） */
  readonly r2Objects: ReadonlyMap<string, string>;
  readonly missingTextureFiles: readonly string[];
  readonly dryRun: boolean;
  readonly durationMs: number;
}

/** 序列化报告（verify --report-in 消费同一格式做期望值对账） */
export function serializeMigrateResult(result: MigrateResult): string {
  return JSON.stringify({
    stages: result.stages,
    missingTextureFiles: result.missingTextureFiles,
    // R2 清单：verify --r2-check 消费它对已上传文件做内容哈希复核
    r2Objects: Object.fromEntries(result.r2Objects),
    dryRun: result.dryRun,
    durationMs: result.durationMs,
  }, null, 2);
}

/** 从序列化文件恢复 skipped 统计（verify 用）。ignored（被唯一索引吞掉的
 * 冲突行）并入对应阶段的 skipped —— 对 verify 而言两者都是"旧行不在新库"。 */
export function extractStageSkipped(serialized: string): Record<string, Record<string, number>> {
  const parsed = JSON.parse(serialized) as { stages: StageResult[] };
  const out: Record<string, Record<string, number>> = {};
  for (const s of parsed.stages) {
    const skipped = { ...s.skipped };
    if (s.ignored > 0) {
      skipped['unique-conflict'] = (skipped['unique-conflict'] ?? 0) + s.ignored;
    }
    out[s.stage] = skipped;
  }
  return out;
}

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const started = Date.now();
  const tz = opts.timeZone ?? LEGACY_DEFAULT_TIMEZONE;
  const log = opts.onProgress ?? (() => {});
  const stages: StageResult[] = [];

  // 密码算法是迁移的硬前提；SALT 缺失在 analyze 是 blocker，这里二次防呆
  const algo = PWD_METHOD_TO_ALGO[opts.pwdMethod.toUpperCase()];
  if (!algo) throw new Error(`无法识别的 PWD_METHOD: ${opts.pwdMethod}`);
  if (ALGOS_REQUIRING_LEGACY_SALT.has(algo) && !opts.legacySalt) {
    throw new Error(`PWD_METHOD=${opts.pwdMethod} 需要旧站 SALT（--legacy-salt）`);
  }

  const ctx = {
    source: opts.source,
    target: opts.target,
    tz,
    notificationTz: opts.notificationTimeZone ?? tz,
    algo: algo as LegacyPasswordAlgo,
    batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
    dryRun: opts.dryRun ?? false,
    log,
    presentHashes: scanTextureDir(opts.texturesDir),
    texturesDir: opts.texturesDir ?? null,
  };

  // 阶段顺序即依赖顺序（外键）：users → textures → players → …
  const order: readonly Stage[] = [
    'schema', 'users', 'textures', 'players', 'closet',
    'reports', 'notifications', 'settings', 'uuid', 'descriptions', 'pigeon', 'files',
  ];
  const resumeIdx = opts.resumeFrom ? order.indexOf(opts.resumeFrom.stage) : -1;

  for (const stage of order) {
    const i = order.indexOf(stage);
    if (resumeIdx >= 0 && i < resumeIdx) continue; // checkpoint 已覆盖
    const skipOffset = i === resumeIdx ? (opts.resumeFrom?.offset ?? 0) : 0;
    log(`阶段 ${stage}${skipOffset > 0 ? `（从第 ${skipOffset} 行续跑）` : ''}`);

    switch (stage) {
      case 'schema':
        // schema 是幂等 DDL，dry-run 也应用：后续阶段的悬空引用过滤
        // 需要查询目标库的 textures/users 表
        await opts.target.applySchema(opts.schemaSql);
        stages.push({ stage, total: 1, written: opts.dryRun ? 0 : 1, ignored: 0, skipped: {} });
        break;
      case 'users':
        stages.push(await stageUsers(ctx, skipOffset));
        break;
      case 'textures':
        stages.push(await stageTextures(ctx, skipOffset));
        break;
      case 'players':
        stages.push(await stagePlayers(ctx, skipOffset));
        break;
      case 'closet':
        stages.push(await stageCloset(ctx));
        break;
      case 'reports':
        stages.push(await stageReports(ctx));
        break;
      case 'notifications':
        stages.push(await stageNotifications(ctx));
        break;
      case 'settings':
        stages.push(await stageSettings(ctx));
        break;
      case 'uuid':
        stages.push(await stageUuid(ctx));
        break;
      case 'descriptions':
        stages.push(await stageDescriptions(ctx));
        break;
      case 'pigeon':
        stages.push(await stagePigeon(ctx));
        break;
      case 'files': {
        // 只产出清单：CLI 不持有 Cloudflare 凭据（那是运维的部署职责）
        if (!opts.texturesDir || ctx.presentHashes === null) {
          stages.push({ stage, total: 0, written: 0, ignored: 0, skipped: {} });
          break;
        }
        const distinct = await opts.source.query<{ hash: string }>(
          `SELECT DISTINCT hash FROM textures`,
        );
        const plan = planR2Objects(
          opts.texturesDir, distinct.map((r) => r.hash), opts.uploadedHashes ?? new Set(),
        );
        stages.push({ stage, total: plan.objects.size, written: plan.objects.size, ignored: 0, skipped: {} });
        r2ObjectsGlobal = plan.objects;
        missingGlobal = plan.missing;
        break;
      }
    }
  }

  return {
    stages,
    r2Objects: r2ObjectsGlobal,
    missingTextureFiles: missingGlobal,
    dryRun: ctx.dryRun,
    durationMs: Date.now() - started,
  };
}

// files 阶段的产物经由模块级变量传出（switch 分支里不便 break 值）。
// migrate() 每次运行都重新赋值，测试串行执行时无残留问题。
let r2ObjectsGlobal: ReadonlyMap<string, string> = new Map();
let missingGlobal: readonly string[] = [];
