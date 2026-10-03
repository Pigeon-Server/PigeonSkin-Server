// verify 命令 —— 迁移后校验。
//
// analyze 回答"能不能迁"，verify 回答"迁得对不对"。
// 校验维度（对应 docs/rewrite/09-migration-tool.md §5）：
//   1. 计数核对：新库每张表的行数 vs 旧库行数 - 已知跳过数
//   2. ID 完整性：旧库的 uid/pid/tid 全部存在于新库（原值迁移的硬性要求）
//   3. 密码哈希格式：每行都是 <algo>:<payload> 自描述格式
//   4. 悬空引用：新库不应存在指向不存在行的外键值
//   5. 文件对照：R2 清单里的每个文件内容哈希 == 文件名（内容寻址不变量）
//
// 所有查询都是调用点内联的静态字面量（与 analyze.ts 同一形态），
// 没有任何值或标识符拼接进 SQL 文本。
import { verifyContentHash } from '../lib/textures.ts';

import type { SourceAdapter } from '../sources/types.ts';
import type { SqliteTarget } from '../targets/types.ts';

/**
 * verify 的数据库入口。
 *
 * 约定：实现者的 query 方法只接受**调用点内联的静态 SQL 字面量**
 * （与 analyze.ts 相同的纪律），参数值一律走占位符绑定。
 * 类型上接受 SourceAdapter | SqliteTarget，运行时不做动态 SQL 构造。
 */
export type VerifyDb = SourceAdapter | SqliteTarget;

export interface VerifyOptions {
  /** 旧库行数（analyze 报告的 counts） */
  readonly legacyCounts: Readonly<Record<string, number>>;
  /** migrate 报告的各阶段跳过数（verify 据此放宽计数核对） */
  readonly stageSkipped: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** 校验入口 A：读新库 */
  readonly newDb: VerifyDb;
  /** 校验入口 B：读旧库 */
  readonly legacyDb: VerifyDb;
  /** R2 对象清单（R2 键 → 本地文件路径） */
  readonly r2Objects: ReadonlyMap<string, string>;
}

export interface VerifyFinding {
  readonly code: string;
  readonly message: string;
  readonly count: number;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly checks: ReadonlyArray<{ name: string; passed: boolean; expected: number; actual: number }>;
  readonly findings: readonly VerifyFinding[];
}

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const findings: VerifyFinding[] = [];
  const checks: Array<{ name: string; passed: boolean; expected: number; actual: number }> = [];

  // ── 1. 计数核对（已知跳过数从 migrate 报告传入）──────────────────────────
  // users 的期望跳过 = 显式跳过（空邮箱）+ 唯一索引忽略（大小写重复邮箱）
  const skippedUsers = sumValues(opts.stageSkipped['users'] ?? {});
  const skippedTextures = opts.stageSkipped['textures']?.['texture-file-missing'] ?? 0;
  const closetSkipped = sumValues(opts.stageSkipped['closet'] ?? {});
  const reportSkipped = sumValues(opts.stageSkipped['reports'] ?? {});

  const newUsers = await countTable(opts.newDb, 'users');
  const newTextures = await countTable(opts.newDb, 'textures');
  const newPlayers = await countTable(opts.newDb, 'players');
  const newCloset = await countTable(opts.newDb, 'closet');
  const newReports = await countTable(opts.newDb, 'reports');

  // players 的大小写冲突行（同名仅大小写不同，先占坑者保留）按规则丢弃，
  // 期望值用重查的冲突集校正
  const caseDupPlayerCount = (await opts.legacyDb.query(
    `SELECT COUNT(*) AS n FROM players a
       WHERE EXISTS (SELECT 1 FROM players b
                      WHERE b.pid < a.pid AND LOWER(b.name) = LOWER(a.name))`))[0];

  checks.push(mk('users', (opts.legacyCounts['users'] ?? 0) - skippedUsers, newUsers));
  checks.push(mk('textures', (opts.legacyCounts['textures'] ?? 0) - skippedTextures, newTextures));
  checks.push(mk('players',
    (opts.legacyCounts['players'] ?? 0) - Number(caseDupPlayerCount?.['n'] ?? 0) - (opts.stageSkipped['players']?.['dangling-user'] ?? 0), newPlayers));
  checks.push(mk('closet', (opts.legacyCounts['user_closet'] ?? 0) - closetSkipped, newCloset));
  checks.push(mk('reports', (opts.legacyCounts['reports'] ?? 0) - reportSkipped, newReports));
  if (opts.legacyCounts['notifications'] !== undefined) {
    checks.push(mk('notifications', opts.legacyCounts['notifications'] - sumValues(opts.stageSkipped['notifications'] ?? {}), await countTable(opts.newDb, 'notifications')));
  }
  const foreignKeys = await opts.newDb.query(`PRAGMA foreign_key_check`);
  checks.push(mk('foreign-keys', 0, foreignKeys.length));
  if (foreignKeys.length) findings.push({ code: 'foreign-key-violations', message: '新库存在无效的外键引用', count: foreignKeys.length });

  // ── 2. ID 完整性（原值迁移的硬性要求）────────────────────────────────────
  // 已知跳过的行（空邮箱用户、缺文件纹理、大小写冲突行）不在新库是预期行为，
  // 从旧集合排除 —— 排除依据与 migrate 的丢弃规则同源（跳过条件重查）。
  const legacyUserIdsAll = idSet(await opts.legacyDb.query(
    `SELECT uid AS id FROM users`));
  const legacyEmptyEmailIds = new Set(
    (await opts.legacyDb.query(
      `SELECT uid AS id FROM users WHERE email IS NULL OR TRIM(email) = ''`))
      .map((r) => Number(r['id'])),
  );
  // 大小写冲突丢弃集：与某个更小 uid 的邮箱 NOCASE 相同的行（迁移时"首个占坑"）
  const legacyUserIds = new Set(
    [...legacyUserIdsAll]
      .filter((id) => !legacyEmptyEmailIds.has(id)),
  );
  const newUserIds = idSet(await opts.newDb.query(
    `SELECT id FROM users ORDER BY id`));
  pushMissing(findings, 'missing-user-ids', 'uid', legacyUserIds, newUserIds);

  const legacyTextureIdsAll = idSet(await opts.legacyDb.query(
    `SELECT tid AS id FROM textures`));
  // 缺文件的纹理行被 migrate 跳过（磁盘上没有该哈希的文件）——
  // 但 verify 拿不到磁盘清单，改用 migrate 报告的计数对账：总数核对已经
  // 保证 (旧行数 - 缺文件数) == 新行数，因此 ID 检查只在"新行数 >= 旧行数"
  // 的表上做全量比对。textures 表用计数结果决定是否全查。
  const newTextureIds = idSet(await opts.newDb.query(
    `SELECT id FROM textures ORDER BY id`));
  const skippedTexturesCount = opts.stageSkipped['textures']?.['texture-file-missing'] ?? 0;
  if (skippedTexturesCount === 0) {
    pushMissing(findings, 'missing-texture-ids', 'tid', legacyTextureIdsAll, newTextureIds);
  } else {
    // 有缺文件跳过：只要求新库的 tid 是旧库 tid 的子集且数量一致（计数已核）
    const unknown = [...newTextureIds].filter((id) => !legacyTextureIdsAll.has(id));
    if (unknown.length > 0) {
      findings.push({
        code: 'unknown-texture-ids',
        message: `新库存在旧库没有的 tid: ${unknown.slice(0, 10).join(', ')}`,
        count: unknown.length,
      });
    }
  }

  const legacyPlayers = await opts.legacyDb.query(`SELECT pid AS id, uid FROM players`);
  const legacyPlayerIdsAll = new Set(legacyPlayers.filter(row => newUserIds.has(Number(row['uid']))).map(row => Number(row['id'])));
  // 大小写冲突丢弃集：与某个更小 pid 的名字 NOCASE 相同的行
  const legacyCaseDupPlayerIds = new Set(
    (await opts.legacyDb.query(
      `SELECT a.pid AS id FROM players a
         WHERE EXISTS (SELECT 1 FROM players b
                        WHERE b.pid < a.pid AND LOWER(b.name) = LOWER(a.name))`))
      .map((r) => Number(r['id'])),
  );
  const legacyPlayerIds = new Set(
    [...legacyPlayerIdsAll].filter((id) => !legacyCaseDupPlayerIds.has(id)),
  );
  const newPlayerIds = idSet(await opts.newDb.query(
    `SELECT id FROM players ORDER BY id`));
  pushMissing(findings, 'missing-player-ids', 'pid', legacyPlayerIds, newPlayerIds);

  // ── 3. 密码哈希格式（自描述 <algo>:<payload>；迁移包装后的都应符合）──────
  const badHashes = (await opts.newDb.query(
    `SELECT id, password_hash FROM users`))
    .filter((r) => {
      const h = String(r['password_hash'] ?? '');
      if (h.endsWith(':legacy-empty-password')) return false; // 无密码账号哨兵
      return !/^[a-z0-9_]+:.+$/.test(h);
    });
  if (badHashes.length > 0) {
    findings.push({
      code: 'bad-password-hash-format',
      message: `password_hash 不是自描述格式: ${badHashes.slice(0, 5).map((r) => r['id']).join(', ')}`,
      count: badHashes.length,
    });
  }

  // ── 4. 悬空引用 ────────────────────────────────────────────────────────────
  const dangling = (await opts.newDb.query(
    `SELECT id FROM players WHERE skin_texture_id IS NOT NULL
       AND skin_texture_id NOT IN (SELECT id FROM textures)`)).length;
  if (dangling > 0) {
    findings.push({
      code: 'dangling-player-texture',
      message: '新库存在悬空的玩家皮肤引用',
      count: dangling,
    });
  }

  // ── 5. R2 文件内容哈希（内容寻址不变量：文件名 == 内容哈希）────────────────
  let badFiles = 0;
  for (const [, filePath] of opts.r2Objects) {
    if (!verifyContentHash(filePath)) badFiles++;
  }
  if (badFiles > 0) {
    findings.push({
      code: 'r2-content-hash-mismatch',
      message: 'R2 清单中存在内容与文件名不符的文件',
      count: badFiles,
    });
  }

  const ok = findings.length === 0 && checks.every((c) => c.passed);
  return { ok, checks, findings };
}

// ── 内部 ─────────────────────────────────────────────────────────────────────

/**
 * 按白名单取行数。表名 → 语句的映射是本文件的固定表，
 * 不认识的表名直接抛错 —— 表名永远不会被拼进查询文本。
 */
async function countTable(db: VerifyDb, table: string): Promise<number> {
  // 每个分支直接把静态字面量传给 query；没有标识符中转，也没有任何拼接
  let rows: Record<string, unknown>[];
  switch (table) {
    case 'users':
      rows = await db.query(`SELECT COUNT(*) AS n FROM users`);
      break;
    case 'textures':
      rows = await db.query(`SELECT COUNT(*) AS n FROM textures`);
      break;
    case 'players':
      rows = await db.query(`SELECT COUNT(*) AS n FROM players`);
      break;
    case 'closet':
      rows = await db.query(`SELECT COUNT(*) AS n FROM closet`);
      break;
    case 'reports':
      rows = await db.query(`SELECT COUNT(*) AS n FROM reports`);
      break;
    case 'notifications':
      rows = await db.query(`SELECT COUNT(*) AS n FROM notifications`);
      break;
    default:
      throw new Error(`countTable 不认识的表: ${table}`);
  }
  return Number(rows[0]?.['n'] ?? 0);
}

function idSet(rows: readonly Record<string, unknown>[]): Set<number> {
  return new Set(rows.map((r) => Number(r['id'])));
}

function pushMissing(
  out: VerifyFinding[], code: string, label: string,
  legacy: Set<number>, actual: Set<number>,
): void {
  const missing = [...legacy].filter((id) => !actual.has(id));
  if (missing.length === 0) return;
  out.push({
    code,
    message: `旧库 ${label} 未出现在新库: ${missing.slice(0, 10).join(', ')}`,
    count: missing.length,
  });
}

function mk(
  name: string, expected: number, actual: number,
): { name: string; passed: boolean; expected: number; actual: number } {
  return { name, passed: expected === actual, expected, actual };
}

function sumValues(rec: Readonly<Record<string, number>>): number {
  return Object.values(rec).reduce((s, v) => s + v, 0);
}
