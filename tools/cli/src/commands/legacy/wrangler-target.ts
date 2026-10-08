// wrangler d1 目标 —— 实现 tools/migrate 的 TargetAdapter 接口。
//
// wrangler d1 execute --file 不支持参数绑定，因此把 BoundStatement 的 `?`
// 参数按 SQLite 字面量规则内联进 SQL 后走 --file。参数全部来自 mapper
// 的映射输出（标量：number/string/null），不含任意用户输入的二进制。
// runBatch 失败时抛错（stages 的 flush 会带上下文）—— 不做跨批事务，
// 与 CLI 其他命令一致：幂等语句 + OR IGNORE 保证重跑安全。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TargetAdapter, BoundStatement } from '@pigeon-skin/migrate/src/targets/types';
import type { TargetEnv } from '../../lib/env.ts';
import { spawnNpmCli } from '../../lib/npm-cli.ts';
import { apiWorkingDir } from '../../lib/env.ts';

const MAX_BUFFER = 512 * 1024 * 1024;

/** SQLite 字面量内联：string 单引号转义、number 直写、null/undefined → NULL、boolean → 0/1 */
function inlineValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`无法内联的数值: ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`;
  // bigint、Buffer 等超出 stage 语句的参数域
  throw new Error(`无法内联的参数类型: ${typeof v}`);
}

/** 目标库"已存在"类错误：0013 触发器 RAISE 的 email 冲突等（跳过该行 = 迁移不覆盖已有数据） */
function isConflictError(message: string): boolean {
  return /UNIQUE constraint failed/.test(message);
}

// users 与 textures 互相引用（users.avatar_texture_id → textures.id，
// textures.uploader_id → users.id），而 D1 强制外键且 INSERT OR IGNORE
// 不抑制 FK 失败 —— 任何线性顺序都无法按原值单遍插入（tools/migrate 的
// SqliteTarget 靠 enableForeignKeyConstraints: false 绕开，wrangler D1 没有
// 这个开关）。处理：INSERT_USER 的 avatar_texture_id 参数改写为 NULL，
// textures 全部落库后由 runLegacyMigrate 统一回填。
// INSERT_USER 模板（tools/migrate/schema/statements.ts）第 6 个 ? 是 avatar_texture_id。
function deferAvatar(stmt: BoundStatement): BoundStatement {
  if (!stmt.sql.includes('INSERT OR IGNORE INTO users')) return stmt;
  const AVATAR_PARAM_INDEX = 5; // 0-based：id,email,nickname,locale,score,avatar_texture_id
  const params = [...stmt.params];
  params[AVATAR_PARAM_INDEX] = null;
  return { sql: stmt.sql, params };
}

function inlineStatement(stmt: BoundStatement): string {
  let out = '';
  let paramIndex = 0;
  const sql = stmt.sql;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") {
      // SQL 字面量段原样保留（语句模板来自 tools/migrate 静态常量，无内嵌字符串）
      const end = sql.indexOf("'", i + 1);
      out += sql.slice(i, end === -1 ? sql.length : end + 1);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '?' && (i === 0 || sql[i - 1] !== '?')) {
      if (paramIndex >= stmt.params.length) {
        throw new Error(`语句需要超过 ${stmt.params.length} 个参数: ${stmt.sql.slice(0, 80)}`);
      }
      out += inlineValue(stmt.params[paramIndex++]!);
      continue;
    }
    out += ch;
  }
  if (paramIndex !== stmt.params.length) {
    throw new Error(`语句参数数量不匹配（占位 ${paramIndex}，提供 ${stmt.params.length}）: ${stmt.sql.slice(0, 80)}`);
  }
  return out;
}

export class WranglerD1Target implements TargetAdapter {
  readonly kind = 'd1-http' as const;
  readonly describe: string;

  private readonly targetEnv: TargetEnv;
  /** 目标库已有 users.email（lower-case）。首次遇到 INSERT_USER 时懒加载，
   * 用于预过滤重跑场景 —— 避免整批冲突触发 O(log n) 二分重试风暴。 */
  private existingEmails: Set<string> | null = null;

  constructor(env: TargetEnv) {
    this.targetEnv = env;
    this.describe = `D1 ${env.d1Database}（${env.label}，wrangler）`;
  }

  private executeFile(statements: readonly string[]): { changes: number } {
    if (statements.length === 0) return { changes: 0 };
    const dir = mkdtempSync(join(tmpdir(), 'pigeon-cli-mig-'));
    const file = join(dir, 'batch.sql');
    try {
      writeFileSync(file, statements.join(';\n') + ';\n', { mode: 0o600 });
      const result = spawnNpmCli(
        ['exec', '--offline', '--', 'wrangler', 'd1', 'execute', this.targetEnv.d1Database,
          this.targetEnv.scopeFlag, '--config', 'wrangler.jsonc', '--json', '--file', file,
          ...(this.targetEnv.persistTo ? ['--persist-to', this.targetEnv.persistTo] : [])],
        { cwd: apiWorkingDir(), encoding: 'utf8', maxBuffer: MAX_BUFFER },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const err = typeof result.stderr === 'string' ? result.stderr.trim() : '';
        const out = typeof result.stdout === 'string' ? result.stdout.trim() : '';
        throw new Error(`D1 写入失败（exit ${result.status ?? '?'}）:\nSTDOUT: ${out.slice(0, 3000)}\nSTDERR: ${err.slice(0, 3000)}`);
      }
      let changes = 0;
      try {
        const parsed = JSON.parse(result.stdout!) as { meta?: { changes?: number } }[];
        for (const s of parsed) changes += s.meta?.changes ?? 0;
      } catch { /* 输出解析失败不算写入失败 */ }
      return { changes };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async runBatch(statements: readonly BoundStatement[]): Promise<number> {
    if (statements.length === 0) return 0;
    // meta.changes 对 OR IGNORE 混合语句的统计不可靠（见 data.ts 同类问题）；
    // stages 的 flush 只在非 dryRun 时调用 runBatch，行数语义由 ignored 差值近似，
    // 报告以 written/ignored 展示，这里返回 changes 即可。
    const filtered = await this.prefilterExistingUsers(statements);
    const inlined = filtered.map((s) => inlineStatement(deferAvatar(s)));
    let changes = 0;
    // 60 语句/批：迁移语句较宽（15+ 列），控制单文件大小
    for (let i = 0; i < inlined.length; i += 60) {
      changes += await this.executeBatchWithRetry(inlined.slice(i, i + 60));
    }
    return changes;
  }

  /**
   * 预过滤目标库已有 email 的 INSERT_USER 语句：这些行会被 0013 触发器 RAISE 拒绝，
   * 提前跳过避免重跑（目标全冲突）时二分重试退化成每行一次 spawn。
   * INSERT_USER 参数序（tools/migrate statements.ts）：email 是第 2 个参数（0-based 1），
   * legacy_email_conflict 是第 15 个（0-based 14）。
   * 只剔除 conflict=0 的行 —— conflict=1 的行（源内重复邮箱的关联账号）触发器本会放行，
   * 应保留交给 OR IGNORE/触发器原语义处理。
   */
  private async prefilterExistingUsers(statements: readonly BoundStatement[]): Promise<readonly BoundStatement[]> {
    const userInserts = statements.filter((s) => s.sql.includes('INSERT OR IGNORE INTO users'));
    if (userInserts.length === 0) return statements;
    if (this.existingEmails === null) {
      this.existingEmails = new Set(
        (await this.query('SELECT email FROM users')).map((r) => String(r['email']).toLowerCase()),
      );
    }
    const emails = new Set(this.existingEmails);
    return statements.filter((s) => {
      if (!s.sql.includes('INSERT OR IGNORE INTO users')) return true;
      if (s.params[14] === 1) return true; // conflict=1：触发器放行的关联账号
      const email = s.params[1];
      if (typeof email !== 'string') return true;
      return !emails.has(email.toLowerCase());
    });
  }

  /**
   * 执行一批；批内语句触发"目标库已存在"类错误（users.email 的 RAISE(ABORT) 触发器
   * 不受 INSERT OR IGNORE 抑制）时二分重试，只跳过冲突行。
   * 典型场景：旧站与新站有重叠用户 —— 迁移不得覆盖已有账号，跳过即正确语义。
   */
  private async executeBatchWithRetry(batch: readonly string[]): Promise<number> {
    if (batch.length === 0) return 0;
    try {
      return this.executeFile(batch).changes;
    } catch (e) {
      if (!isConflictError((e as Error).message) || batch.length === 1) {
        if (batch.length === 1 && isConflictError((e as Error).message)) return 0; // 单行冲突：跳过
        throw e;
      }
      const mid = Math.floor(batch.length / 2);
      const a = await this.executeBatchWithRetry(batch.slice(0, mid));
      const b = await this.executeBatchWithRetry(batch.slice(mid));
      return a + b;
    }
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    // stages 的 target.query 只用两条 SELECT（NEW_USER_IDS / NEW_TEXTURE_IDS）
    const { d1Query } = await import('../../lib/wrangler.ts');
    return d1Query(this.targetEnv, sql) as T[];
  }

  /** 供 migrate-run 的回填等直接执行已内联的 SQL（绕过 deferAvatar/参数域） */
  async runBatchRaw(statements: readonly string[]): Promise<number> {
    let changes = 0;
    for (let i = 0; i < statements.length; i += 60) {
      changes += await this.executeBatchWithRetry(statements.slice(i, i + 60));
    }
    return changes;
  }

  /** 目标库 schema 由 wrangler d1 migrations 管理；这里恒为空操作 */
  async applySchema(): Promise<void> {}

  async close(): Promise<void> {}
}
