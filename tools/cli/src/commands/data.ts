// data 命令组：export / import / stats —— 核心业务表的 JSON 备份。
// 导出文件含密码哈希与会话令牌哈希等敏感字段，属运维级资料，须妥善保管。
//
// 导入顺序针对 D1 的外键约束设计（D1/miniflare 默认强制 FK）：
// users 与 textures 互相引用（users.avatar_texture_id → textures.id，
// textures.uploader_id → users.id），任何线性顺序都无法按原值一次插入，
// 因此 users 先以 avatar_texture_id = NULL 插入，textures 之后再回填。

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetEnv } from '../lib/env.ts';
import { d1Query, d1ExecuteFile } from '../lib/wrangler.ts';
import { sqlText, sqlIntOrNull } from '../lib/sql.ts';
import { resolveOutputPath, resolveExistingDir, PathValidationError } from '../lib/paths.ts';
import { flagString, hasFlag, type ParsedArgs } from '../lib/args.ts';

interface TableSpec {
  readonly name: string;
  /** SELECT 的列清单（白名单，不含派生敏感数据的表可选列） */
  readonly columns: readonly string[];
  /** 自然键（用于导入前的存在性预查；textures 用 hash+uploader 与站点去重语义一致） */
  readonly naturalKey?: readonly string[];
  /** 生成 INSERT 语句（列名白名单 + 值转义都收在这里，不拼接任何非白名单输入） */
  readonly toInsert: (row: Record<string, unknown>) => string;
}

const q = sqlText;
const i = sqlIntOrNull;

function boolOf(v: unknown): string {
  return v ? '1' : '0';
}

// ── 表规格（列名全部来自 packages/db/migrations，值转义走 sql.ts） ─────────────

const TABLES: readonly TableSpec[] = [
  {
    name: 'textures',
    columns: ['id', 'hash', 'kind', 'model', 'name', 'official_key', 'catalog_revision', 'uploader_id',
      'source_resource_id', 'origin', 'size_bytes', 'score_refund_basis', 'score_award', 'visibility',
      'width', 'height', 'likes', 'created_at', 'updated_at'],
    // 备份恢复按主键 id 判定：hash 不唯一是站点允许的（同 hash+uploader 可有多行，
    // 旧库遗留重复），按 hash+uploader 判定会误跳过重复行、进而让 players 的引用悬空
    naturalKey: ['id'],
    toInsert: (r) =>
      `INSERT OR IGNORE INTO textures (id, hash, kind, model, name, official_key, catalog_revision, uploader_id, source_resource_id, origin, size_bytes, score_refund_basis, score_award, visibility, width, height, likes, created_at, updated_at) `
      + `SELECT ${i(r.id as number)}, ${q(r.hash as string)}, ${q(r.kind as string)}, ${r.model === null ? 'NULL' : q(r.model as string)}, ${q(r.name as string)}, ${r.official_key === null ? 'NULL' : q(r.official_key as string)}, ${i(r.catalog_revision as number)}, ${i(r.uploader_id as number | null)}, ${i(r.source_resource_id as number | null)}, ${q(r.origin as string)}, ${i(r.size_bytes as number)}, ${i(r.score_refund_basis as number)}, ${i(r.score_award as number)}, ${q(r.visibility as string)}, ${i(r.width as number)}, ${i(r.height as number)}, ${i(r.likes as number)}, ${i(r.created_at as number)}, ${i(r.updated_at as number)} WHERE NOT EXISTS (SELECT 1 FROM textures WHERE id = ${i(r.id as number)})`,
  },
  {
    name: 'users',
    columns: ['id', 'email', 'legacy_email_conflict', 'merged_into_user_id', 'email_verified_at', 'nickname',
      'locale', 'score', 'avatar_texture_id', 'password_hash', 'needs_initialization',
      'password_rehash_required', 'role', 'signature', 'registration_ip', 'is_dark_mode',
      'last_sign_at', 'created_at', 'updated_at'],
    naturalKey: ['email'],
    toInsert: (r) =>
      `INSERT OR IGNORE INTO users (id, email, legacy_email_conflict, merged_into_user_id, email_verified_at, nickname, locale, score, avatar_texture_id, password_hash, needs_initialization, password_rehash_required, role, signature, registration_ip, is_dark_mode, last_sign_at, created_at, updated_at) `
      + `SELECT ${i(r.id as number)}, ${q(r.email as string)}, ${boolOf(r.legacy_email_conflict)}, ${i(r.merged_into_user_id as number | null)}, ${i(r.email_verified_at as number | null)}, ${q(r.nickname as string)}, ${r.locale === null ? 'NULL' : q(r.locale as string)}, ${i(r.score as number)}, NULL, ${q(r.password_hash as string)}, ${boolOf(r.needs_initialization)}, ${boolOf(r.password_rehash_required)}, ${q(r.role as string)}, ${q(r.signature as string)}, ${r.registration_ip === null ? 'NULL' : q(r.registration_ip as string)}, ${boolOf(r.is_dark_mode)}, ${i(r.last_sign_at as number | null)}, ${i(r.created_at as number)}, ${i(r.updated_at as number)} WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ${q(r.email as string)})`,
  },
  {
    name: 'textures_description',
    columns: ['tid', 'description', 'updated_at'],
    naturalKey: ['tid'],
    toInsert: (r) =>
      `INSERT OR IGNORE INTO textures_description (tid, description, updated_at) `
      + `SELECT ${i(r.tid as number)}, ${q(r.description as string)}, ${i(r.updated_at as number)} WHERE NOT EXISTS (SELECT 1 FROM textures_description WHERE tid = ${i(r.tid as number)})`,
  },
  {
    name: 'players',
    columns: ['id', 'user_id', 'name', 'skin_texture_id', 'cape_texture_id', 'score_paid', 'created_at', 'updated_at'],
    naturalKey: ['name'],
    toInsert: (r) =>
      `INSERT OR IGNORE INTO players (id, user_id, name, skin_texture_id, cape_texture_id, score_paid, created_at, updated_at) `
      + `SELECT ${i(r.id as number)}, ${i(r.user_id as number)}, ${q(r.name as string)}, ${i(r.skin_texture_id as number | null)}, ${i(r.cape_texture_id as number | null)}, ${i(r.score_paid as number)}, ${i(r.created_at as number | null)}, ${i(r.updated_at as number)} WHERE NOT EXISTS (SELECT 1 FROM players WHERE name = ${q(r.name as string)})`,
  },
  {
    name: 'closet',
    columns: ['user_id', 'texture_id', 'item_name', 'is_default', 'created_at'],
    naturalKey: ['user_id', 'texture_id'],
    toInsert: (r) =>
      `INSERT OR IGNORE INTO closet (user_id, texture_id, item_name, is_default, created_at) `
      + `SELECT ${i(r.user_id as number)}, ${i(r.texture_id as number)}, ${r.item_name === null ? 'NULL' : q(r.item_name as string)}, ${boolOf(r.is_default)}, ${i(r.created_at as number)} WHERE NOT EXISTS (SELECT 1 FROM closet WHERE user_id = ${i(r.user_id as number)} AND texture_id = ${i(r.texture_id as number)})`,
  },
];

/** 导入顺序：users 先行（avatar 置 NULL），textures_description/players/closet 引用前两者。
 * textures 必须在 users 之后（uploader_id 外键）——恢复时 avatar_texture_id 靠回填补齐。 */
const IMPORT_ORDER = ['users', 'textures', 'textures_description', 'players', 'closet'];

const TABLE_NAMES = TABLES.map((t) => t.name);

/** 由自然键生成 WHERE 片段（值经 sqlText/sqlIntOrNull 转义；键名来自白名单 spec）。
 * 自然键列缺失（备份行不完整）时返回 null，调用方按"无法预判"处理。 */
function naturalKeyWhere(spec: TableSpec, row: Record<string, unknown>): string | null {
  if (!spec.naturalKey) return null;
  const parts: string[] = [];
  for (const col of spec.naturalKey) {
    const v = row[col];
    if (v === null || v === undefined) {
      // textures.uploader_id 允许 NULL（无主行）
      if (v === null && col === 'uploader_id') { parts.push('uploader_id IS NULL'); continue; }
      return null;
    }
    if (typeof v === 'number') parts.push(`${col} = ${sqlIntOrNull(v)}`);
    else if (typeof v === 'string') parts.push(`${col} = ${sqlText(v)}`);
    else return null;
  }
  return parts.join(' AND ');
}

function tableSpec(name: string): TableSpec {
  const spec = TABLES.find((t) => t.name === name);
  if (!spec) throw new Error(`未知表: ${name}（可用: ${TABLE_NAMES.join(', ')}）`);
  return spec;
}

export async function runData(env: TargetEnv, action: string, parsed: ParsedArgs): Promise<number> {
  switch (action) {
    case 'export': return dataExport(env, parsed.flags);
    case 'import': return dataImport(env, parsed.flags);
    case 'stats': return dataStats(env);
    default:
      throw new Error(`未知 data 子命令 "${action}"（可用: export | import | stats）`);
  }
}

// ── export ──────────────────────────────────────────────────────────────────

function dataExport(env: TargetEnv, flags: ReadonlyMap<string, string | true>): number {
  const outDir = resolveOutputPath(flagString(flags, 'out') ?? '', '--out');
  const tablesText = flagString(flags, 'tables');
  const specs = tablesText !== undefined
    ? tablesText.split(',').map((s) => tableSpec(s.trim()))
    : TABLES;

  mkdirSync(outDir, { recursive: true });
  const manifest: Record<string, unknown> = {
    env: env.name,
    exportedAt: new Date().toISOString(),
    tables: {} as Record<string, number>,
  };
  const tablesMeta = manifest.tables as Record<string, number>;

  for (const spec of specs) {
    const rows = d1Query(env, `SELECT ${spec.columns.join(', ')} FROM ${spec.name} ORDER BY rowid`);
    writeFileSync(join(outDir, `${spec.name}.json`), JSON.stringify(rows, null, 1), { mode: 0o600 });
    tablesMeta[spec.name] = rows.length;
    console.log(`  ${spec.name}: ${rows.length} 行`);
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(`导出完成 → ${outDir}`);
  console.log('⚠ 备份文件含密码哈希等敏感字段，请妥善保管，不要提交进仓库或公开分享。');
  return 0;
}

// ── import ──────────────────────────────────────────────────────────────────

/** 批量预查自然键已存在性：一批 OR 连接的 WHERE 片段（键可能含 IS NULL，无法直接 IN）。
 * 返回"备份行中已存在"的数量，用于推导插入数。 */
function prefetchExistingKeys(env: TargetEnv, spec: TableSpec, rows: readonly Record<string, unknown>[]): number {
  const keys = rows.map((row) => naturalKeyWhere(spec, row)).filter((k): k is string => k !== null);
  let existing = 0;
  for (let start = 0; start < keys.length; start += 50) {
    const chunk = keys.slice(start, start + 50);
    const sql = `SELECT COUNT(*) AS n FROM ${spec.name} WHERE ${chunk.join(' OR ')}`;
    if (sql.length > 900_000) throw new Error(`${spec.name} 自然键查询过长，请拆分备份文件`);
    existing += Number(d1Query(env, sql)[0]?.n ?? 0);
  }
  return existing;
}

function dataImport(env: TargetEnv, flags: ReadonlyMap<string, string | true>): number {
  const fromDirFlag = flagString(flags, 'from');
  if (fromDirFlag === undefined) throw new Error('需要 --from <备份目录>');
  const fromDir = resolveExistingDir(fromDirFlag, '--from');
  const manifestPath = join(fromDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`缺少 manifest.json: ${fromDir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    env?: string; tables?: Record<string, number>;
  };

  const update = hasFlag(flags, 'update');
  if (update) throw new Error('--update 暂未实现：当前版本只做跳过式合并（删除或改动过的行不会被覆盖）');
  const yes = hasFlag(flags, 'yes');
  if (!yes) {
    console.error('data import 会向数据库写入业务数据。确认无误后加 --yes 执行。');
    console.error('当前为跳过式合并：已存在的行（按自然键）不会被改动。');
    return 2;
  }

  // 只导入备份目录真实存在的表；顺序固定为 IMPORT_ORDER（FK 约束要求）
  const recorded = manifest.tables ?? {};
  const available = TABLES.filter((t) => recorded[t.name] !== undefined || existsSync(join(fromDir, `${t.name}.json`)));
  if (available.length === 0) throw new Error(`备份目录中没有可导入的表文件: ${fromDir}`);
  const specs = IMPORT_ORDER.filter((n) => available.some((t) => t.name === n)).map(tableSpec);

  console.log(`导入计划 → ${env.label}（跳过式合并，已存在行不改动）`);
  for (const spec of specs) {
    const file = join(fromDir, `${spec.name}.json`);
    if (!existsSync(file)) { console.log(`  ${spec.name}: 备份中无此表，跳过`); continue; }
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    // D1 对 INSERT … SELECT … WHERE NOT EXISTS 的 meta.changes 统计不可靠（实测恒为 0），
    // 插入数由导入前的存在性预查推导；预查与写入之间的并发写入会被 OR IGNORE 兜底
    const existing = prefetchExistingKeys(env, spec, rows);
    const statements: string[] = [];
    for (const row of rows) {
      statements.push(spec.toInsert(row));
      if (statements.length >= 100) {
        d1ExecuteFile(env, statements);
        statements.length = 0;
      }
    }
    if (statements.length > 0) d1ExecuteFile(env, statements);
    const inserted = rows.length - existing;
    console.log(`  ${spec.name}: 读入 ${rows.length}，插入 ${inserted}，跳过 ${existing}`);
  }

  // 回填 users.avatar_texture_id：users 先于 textures 插入时置了 NULL
  if (specs.some((s) => s.name === 'users') && specs.some((s) => s.name === 'textures')) {
    const users = JSON.parse(readFileSync(join(fromDir, 'users.json'), 'utf8')) as Record<string, unknown>[];
    const statements: string[] = [];
    for (const row of users) {
      const avatar = row['avatar_texture_id'];
      if (avatar === null || avatar === undefined) continue;
      statements.push(
        `UPDATE users SET avatar_texture_id = ${i(avatar as number)} WHERE email = ${q(row['email'] as string)} `
        + `AND (avatar_texture_id IS NULL OR avatar_texture_id != ${i(avatar as number)})`,
      );
      if (statements.length >= 100) { d1ExecuteFile(env, statements); statements.length = 0; }
    }
    if (statements.length > 0) d1ExecuteFile(env, statements);
    console.log(`  users.avatar_texture_id: 已回填（${users.length} 行核对）`);
  }

  console.log('导入完成。注意：textures 行可导入，但 PNG 文件本体在 R2 中需另行确认（可用 textures export/import 校对）。');
  return 0;
}

// ── stats ───────────────────────────────────────────────────────────────────

function dataStats(env: TargetEnv): number {
  console.log(`${env.label} 核心表行数:`);
  for (const name of TABLE_NAMES) {
    try {
      const rows = d1Query(env, `SELECT COUNT(*) AS n FROM ${name}`);
      console.log(`  ${name}: ${Number(rows[0]?.n ?? 0)}`);
    } catch {
      // 目标库可能尚未应用包含该表的迁移（如生产滞后于代码）
      console.log(`  ${name}: 不可读（表不存在或查询失败）`);
    }
  }
  return 0;
}

// re-export 供测试使用
export { TABLES, TABLE_NAMES, IMPORT_ORDER, PathValidationError };
