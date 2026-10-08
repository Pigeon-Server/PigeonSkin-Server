// legacy 迁移编排：discover → analyze（复用 tools/migrate）→ stages（复用）
// → WranglerD1Target 写入 + r2Put 纹理对象 → 报告。
//
// 与 tools/migrate 自带 migrate 命令的区别只在适配器：
//   source = MySQL 直连 或 dump→临时 SQLite；target = wrangler 管的 D1（不是本地 .sqlite）。
// 映射、分页、跳过、断点语义全部来自 tools/migrate，这里不复制。

import { readdirSync, statSync as fsStatSync } from 'node:fs';
import { join } from 'node:path';
import { textureObjectKey } from '@pigeon-skin/minecraft';
import type { SourceAdapter } from '@pigeon-skin/migrate/src/sources/types';
import type { TargetAdapter } from '@pigeon-skin/migrate/src/targets/types';
import { analyze, type AnalyzeOptions } from '@pigeon-skin/migrate/src/commands/analyze';
import type { StageContext } from '@pigeon-skin/migrate/src/commands/stages';
import { stageUsers, stageTextures } from '@pigeon-skin/migrate/src/commands/stages-core';
import { stagePlayers, stageCloset, stageReports, stageNotifications, stageSettings, stageDescriptions, stageUuid } from '@pigeon-skin/migrate/src/commands/stages-social';
import { scanTextureDir } from '@pigeon-skin/migrate/src/lib/textures';
import { summarize, renderReport } from '@pigeon-skin/migrate/src/lib/report';
import { legacyDateTimeToEpoch } from '@pigeon-skin/migrate/src/lib/date';
import { PWD_METHOD_TO_ALGO, ALGOS_REQUIRING_LEGACY_SALT, type LegacyPasswordAlgo } from '@pigeon-skin/migrate/src/schema/legacy';
import type { TargetEnv } from '../../lib/env.ts';
import { flagString, hasFlag } from '../../lib/args.ts';
import { discoverSource, discoverTexturesDir, type DiscoveredSource } from './discover.ts';
import { loadDumpIntoSqlite } from './dump-source.ts';
import { openMysqlSource } from './mysql-source.ts';
import { WranglerD1Target } from './wrangler-target.ts';
import { r2PutAsync } from '../../lib/wrangler.ts';

const LEGACY_DEFAULT_TIMEZONE = 'Asia/Shanghai';

// ── 源打开 ───────────────────────────────────────────────────────────────────

interface OpenedSource {
  readonly adapter: SourceAdapter;
  /** dump 模式的临时库清理（mysql 模式为关闭连接池） */
  readonly close: () => Promise<void>;
  /** dump 模式解析警告 */
  readonly warnings: readonly string[];
}

async function openSource(discovered: DiscoveredSource): Promise<OpenedSource> {
  if (discovered.kind === 'mysql') {
    const e = discovered.env;
    const adapter = await openMysqlSource({
      host: e.dbHost!,
      port: e.dbPort ?? 3306,
      database: e.dbDatabase!,
      user: e.dbUsername!,
      password: e.dbPassword ?? '',
    });
    return { adapter, close: () => adapter.close(), warnings: [] };
  }

  const warnings: string[] = [];
  const dump = loadDumpIntoSqlite(discovered.dumpPath!, (m) => warnings.push(m));
  const { SqliteSource } = await import('@pigeon-skin/migrate/src/sources/sqlite');
  const adapter: SourceAdapter = new SqliteSource({ path: dump.dbPath, readOnly: true });
  return {
    adapter,
    warnings,
    close: () => {
      adapter.close();
      dump.close();
      return Promise.resolve();
    },
  };
}

/** mysql 连接失败时若目录内有 dump，给出兜底提示 */
async function openSourceInner(discovered: DiscoveredSource, dir: string): Promise<OpenedSource> {
  if (discovered.kind !== 'mysql') return openSource(discovered);
  try {
    return await openSource(discovered);
  } catch (e) {
    const fallback = findDumpInDir(dir);
    if (fallback) {
      throw new Error(`${(e as Error).message}\n目录内有 SQL dump 可用，可加 --dump "${fallback}" 改用快照模式`, { cause: e });
    }
    throw e;
  }
}

function findDumpInDir(dir: string): string | undefined {
  try {
    const dumps = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql') && fsStatSync(join(dir, f)).isFile());
    return dumps.length > 0 ? join(dir, dumps[0]!) : undefined;
  } catch {
    return undefined;
  }
}

// ── analyze ──────────────────────────────────────────────────────────────────

function resolveAlgo(discovered: DiscoveredSource, flags: ReadonlyMap<string, string | true>): { algo: LegacyPasswordAlgo; salt: string | null } {
  const pwdMethod = flagString(flags, 'pwd-method') ?? discovered.env.pwdMethod;
  if (!pwdMethod) {
    throw new Error('无法确定旧站密码算法：.env 无 PWD_METHOD 且未传 --pwd-method（dump 快照必须显式指定）');
  }
  const algo = PWD_METHOD_TO_ALGO[pwdMethod];
  if (!algo) {
    throw new Error(`未知 PWD_METHOD: ${pwdMethod}（可用: ${Object.keys(PWD_METHOD_TO_ALGO).join('|')}）`);
  }
  const salt = flagString(flags, 'legacy-salt') ?? discovered.env.salt ?? null;
  if (ALGOS_REQUIRING_LEGACY_SALT.has(algo) && !salt) {
    throw new Error(`算法 ${algo} 需要旧站 SALT（--legacy-salt 或 .env 的 SALT）`);
  }
  return { algo, salt };
}

async function runAnalyze(
  source: SourceAdapter,
  texturesDir: string | undefined,
  flags: ReadonlyMap<string, string | true>,
  algo: LegacyPasswordAlgo,
  salt: string | null,
) {
  const opts: AnalyzeOptions = {
    source,
    ...(texturesDir !== undefined ? { texturesDir } : {}),
    timeZone: flagString(flags, 'timezone') ?? LEGACY_DEFAULT_TIMEZONE,
    pwdMethod: Object.entries(PWD_METHOD_TO_ALGO).find(([, a]) => a === algo)?.[0],
    legacySalt: salt,
    skipFileHash: hasFlag(flags, 'skip-file-hash'),
  };
  return analyze(opts);
}

// ── analyze 子命令 ───────────────────────────────────────────────────────────

export async function runLegacyAnalyze(_env: TargetEnv, flags: ReadonlyMap<string, string | true>): Promise<number> {
  const dir = flagString(flags, 'dir') ?? '';
  const discovered = discoverSource(dir, flagString(flags, 'dump'));
  console.log(`旧站目录: ${dir}`);
  console.log(`数据源: ${discovered.describe}`);
  const texturesDir = discoverTexturesDir(dir);
  console.log(`纹理目录: ${texturesDir ?? '（未找到 storage/textures）'}`);

  const opened = await openSourceInner(discovered, dir);
  try {
    const { algo, salt } = resolveAlgo(discovered, flags);
    console.log(`密码算法: ${algo}${salt ? '（含 SALT）' : ''}`);
    for (const w of opened.warnings) console.log(`⚠ ${w}`);
    const report = await runAnalyze(opened.adapter, texturesDir, flags, algo, salt);
    console.log(renderReport(report));
    return summarize(report).blockers.length > 0 ? 1 : 0;
  } finally {
    await opened.close();
  }
}

// ── migrate 子命令 ───────────────────────────────────────────────────────────

export async function runLegacyMigrate(env: TargetEnv, flags: ReadonlyMap<string, string | true>): Promise<number> {
  const dir = flagString(flags, 'dir') ?? '';
  const discovered = discoverSource(dir, flagString(flags, 'dump'));
  const texturesDir = discoverTexturesDir(dir);
  const dryRun = hasFlag(flags, 'dry-run');

  // 生产目标防误灌：站点必须处于未初始化状态（users 为空）
  if (env.name === 'production') {
    if (!hasFlag(flags, 'yes')) {
      console.error('错误: 该命令会写入生产库。确认后加 --yes 重新执行。');
      return 2;
    }
    const siteUrl = flagString(flags, 'site-url');
    if (siteUrl) {
      const locked = await checkSiteLocked(siteUrl);
      if (locked === true) {
        console.error(`错误: 目标站点已初始化（${siteUrl}）。为防止覆盖已有数据，拒绝迁移。`);
        return 1;
      }
      if (locked === null) {
        console.error(`警告: 无法访问 ${siteUrl} 的 /setup 接口确认初始化状态，继续执行（--site-url 指向正确站点后可消除此警告）。`);
      }
    } else {
      console.error('警告: 未提供 --site-url，跳过生产站点未初始化检查。请确认目标站点 users 表为空。');
    }
  }

  const opened = await openSourceInner(discovered, dir);
  const target = new WranglerD1Target(env);
  try {
    const { algo, salt } = resolveAlgo(discovered, flags);
    console.log(`迁移目标: ${target.describe}${dryRun ? '（dry-run，不写入）' : ''}`);
    console.log(`数据源: ${discovered.describe}`);
    for (const w of opened.warnings) console.log(`⚠ ${w}`);

    const report = await runAnalyze(opened.adapter, texturesDir, flags, algo, salt);
    const blockers = summarize(report).blockers;
    if (blockers.length > 0 && !hasFlag(flags, 'force')) {
      console.log(renderReport(report));
      console.error('旧库存在阻塞项，拒绝迁移。先解决它们，或确认后加 --force。');
      return 1;
    }

    const presentHashes = texturesDir ? scanTextureDir(texturesDir) : null;
    const ctx: StageContext = {
      source: opened.adapter,
      target: target as unknown as TargetAdapter,
      tz: flagString(flags, 'timezone') ?? LEGACY_DEFAULT_TIMEZONE,
      algo,
      batchSize: Number(flagString(flags, 'batch') ?? '') || 500,
      dryRun,
      log: (m) => console.log(m),
      presentHashes,
      texturesDir: texturesDir ?? null,
    };

    // R2 上传先于 D1 写入 —— "对象在 → 行可见" 是内容寻址缓存安全的前提，
    // 且中断后重跑时 D1 还没有行，重跑能正确补传缺失对象。
    // 跳过判定只能用磁盘 + 源库，不能用目标库（目标库此时可能是上次中断的半成品）。
    let uploaded = 0;
    if (hasFlag(flags, 'skip-r2')) {
      console.log('  R2: 已按 --skip-r2 跳过（纹理对象需事后补传，行可见前对象必须就位）');
    } else if (!dryRun && texturesDir && presentHashes !== null) {
      const sourceTextures = await opened.adapter.query<{ hash: string }>('SELECT DISTINCT hash FROM textures');
      const toUpload = sourceTextures
        .map((r) => String(r['hash']))
        .filter((h) => presentHashes.has(h));
      console.log(`  R2: 需就位 ${toUpload.length} 个对象（按 hash 幂等，重跑已传过的会覆盖同内容对象）`);
      // 本地 --local 模式的 wrangler 进程对同一 bucket 有单例锁，并发会死锁，
      // 必须串行；远程走网络，可用 8 并发
      const CONCURRENCY = env.name === 'local' ? 1 : 8;
      let cursor = 0;
      let failed = 0;
      const worker = async () => {
        while (cursor < toUpload.length) {
          const hash = toUpload[cursor++]!;
          try {
            await r2PutAsync(env, textureObjectKey(hash), join(texturesDir, hash));
            uploaded++;
            if (uploaded % 50 === 0) console.log(`  R2: ${uploaded}/${toUpload.length}`);
          } catch (e) {
            failed++;
            console.error(`  ✗ R2 上传失败 ${hash.slice(0, 12)}: ${(e as Error).message.split('\n')[0]}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(toUpload.length, 1)) }, worker));
      if (failed > 0) {
        console.error(`R2 上传失败 ${failed} 个。重跑 migrate 可补传（已成功的对象按 hash 幂等覆盖，无副作用）；本轮中止，未写 D1。`);
        return 1;
      }
    }

    // FK 依赖序：users（avatar 置 NULL，由 target 改写）→ textures（校验 uploader）→
    // players → closet → 其他；textures 完成后回填 users.avatar_texture_id
    const stages = [
      await stageUsers(ctx, 0),
      await stageTextures(ctx, 0),
      await stagePlayers(ctx, 0),
      await stageCloset(ctx),
      await stageDescriptions(ctx),
      await stageSettings(ctx),
      await stageReports(ctx),
      await stageUuidSafe(ctx),
      await stageNotificationsDeduped(ctx, target, dryRun),
    ];

    // 回填 users.avatar_texture_id（deferAvatar 置 NULL 的那部分）
    if (!dryRun) {
      const backfilled = await backfillAvatars(opened.adapter, target);
      if (backfilled > 0) console.log(`  users.avatar_texture_id: 回填 ${backfilled} 行`);
    }

    console.log('\n迁移结果:');
    let totalWritten = 0;
    for (const s of stages) {
      totalWritten += s.written;
      const skipText = Object.entries(s.skipped).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`  ${s.stage}: ${s.written}${dryRun ? ' (dry-run)' : ''}${skipText ? `  跳过: ${skipText}` : ''}`);
    }
    if (!dryRun && texturesDir) console.log(`  R2 对象: ${uploaded}`);
    console.log(totalWritten === 0 && !dryRun ? '\n未写入任何行（源为空或全部跳过）' : '');
    return 0;
  } finally {
    await opened.close();
  }
}

/** GET /setup：locked=true 已初始化 / false 未初始化 / null 无法确认 */
async function checkSiteLocked(siteUrl: string): Promise<boolean | null> {
  try {
    const url = new URL('/api/v1/setup', siteUrl);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('仅支持 https 站点');
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const body = await res.json() as { locked?: boolean };
    return typeof body.locked === 'boolean' ? body.locked : null;
  } catch {
    return null;
  }
}

/**
 * 回填 users.avatar_texture_id：deferAvatar 把 INSERT_USER 的 avatar 参数改为
 * NULL（FK 循环），textures 落库后按源库的 uid→avatar 映射补齐。
 * 只回填目标 textures 表里真实存在的 tid（磁盘缺文件的行 stageTextures 已置空宽高，
 * 但行还在；指向磁盘缺失文件的 avatar 与 tools/migrate 的 avatar-cleared 语义一致——保留）。
 */
async function backfillAvatars(source: SourceAdapter, target: WranglerD1Target): Promise<number> {
  const rows = await source.query<{ uid: number; avatar: number }>(
    'SELECT uid, avatar FROM users WHERE avatar > 0',
  );
  const textureIds = new Set(
    (await target.query('SELECT id FROM textures')).map((r) => Number(r['id'])),
  );
  let backfilled = 0;
  const statements: string[] = [];
  for (const row of rows) {
    const avatar = Number(row['avatar']);
    if (!textureIds.has(avatar)) continue;
    statements.push(
      `UPDATE users SET avatar_texture_id = ${avatar} WHERE id = ${Number(row['uid'])} `
      + `AND (avatar_texture_id IS NULL OR avatar_texture_id != ${avatar})`,
    );
    if (statements.length >= 60) {
      backfilled += await target.runBatchRaw(statements);
      statements.length = 0;
    }
  }
  if (statements.length > 0) backfilled += await target.runBatchRaw(statements);
  return backfilled;
}

/** uuid 表迁移（yggdrasil 改名保 UUID 语义依赖它）；旧站未装 yggdrasil 时表不存在，静默为空。
 * 其他错误（网络/权限等）不吞 —— 硬报错暴露问题。 */
async function stageUuidSafe(ctx: StageContext) {
  try {
    return await stageUuid(ctx);
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) {
      return { stage: 'uuid' as const, total: 0, written: 0, ignored: 0, skipped: {} };
    }
    throw e;
  }
}

/**
 * notifications 无主键、INSERT 模板无 OR IGNORE —— 重跑会全量翻倍。
 * 以 (user_id,type,title,body,created_at) 为去重键：先查目标库已有键集合，
 * 映射后过滤已存在的行再交给原 stageNotifications。键中的 created_at 必须与
 * 目标库存储格式一致（mapNotification 输出的 UTC epoch 毫秒），源侧行的
 * datetime 字符串要经 legacyDateTimeToEpoch 换算后再构造键。
 */
async function stageNotificationsDeduped(ctx: StageContext, target: WranglerD1Target, dryRun: boolean) {
  const existing = new Set<string>(
    (await target.query(
      'SELECT user_id, type, title, body, created_at FROM notifications',
    )).map((r) => `${r['user_id']}\u0000${r['type']}\u0000${r['title']}\u0000${r['body'] ?? ''}\u0000${r['created_at']}`),
  );
  if (existing.size === 0 || dryRun) return stageNotifications(ctx);

  const notificationTz = ctx.notificationTz ?? ctx.tz;
  const sourceRows = await ctx.source.query<Record<string, unknown>>(
    'SELECT id, type, notifiable_id, data, read_at, created_at FROM notifications',
  );
  const kept = sourceRows.filter((row) => {
    const createdAtEpoch = legacyDateTimeToEpoch(row['created_at'], notificationTz);
    if (createdAtEpoch === null) return true; // 无时间的行 mapNotification 会返回 null，交给原 stage 处理
    const parsed = safeParseNotification(row);
    if (!parsed) return true; // 解析不了的行交给原 stage 的 skip 计数
    const key = `${row['notifiable_id']}\u0000site_message\u0000${parsed.title}\u0000${parsed.body ?? ''}\u0000${createdAtEpoch}`;
    return !existing.has(key);
  });
  const deduped = sourceRows.length - kept.length;
  if (deduped === 0) return stageNotifications(ctx);

  // 用过滤后的行数构造 skip 标记：替换 ctx.source 为一次性行源
  const filteredSource: SourceAdapter = {
    ...ctx.source,
    async query<T>(sql: string): Promise<T[]> {
      // FETCH_NOTIFICATIONS 查询返回通知行；其他查询透传
      if (sql.includes('FROM notifications')) return kept as T[];
      return ctx.source.query<T>(sql);
    },
  };
  const result = await stageNotifications({ ...ctx, source: filteredSource });
  return { ...result, skipped: { ...result.skipped, 'already-in-target': deduped } };
}

function safeParseNotification(row: Record<string, unknown>): { title: string; body: string | null } | null {
  try {
    const parsed = JSON.parse(String(row['data'] ?? '')) as Record<string, unknown>;
    return {
      title: typeof parsed['title'] === 'string' ? parsed['title'] : '（无法解析的旧通知）',
      body: typeof parsed['content'] === 'string' ? parsed['content'] : null,
    };
  } catch {
    return null;
  }
}
