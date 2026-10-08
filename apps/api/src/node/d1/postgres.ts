// PostgreSQL（postgres.js）上的 D1 形状适配器。
//
// 难点与对策：
// - SQLite 的 `?` 占位符 → PG 的 $n。重写引擎把 SQL 文本扫描成 plan，
//   这里把 plan 里的槽位编号为 $1..$N。
// - changes()/last_insert_rowid() → PG 无原生函数。适配器在 batch 中
//   记录上一条语句的 RETURNING 值（写语句自动追加 RETURNING 让驱动
//   拿到 affected/id），哨兵槽位注入该值。
// - INSERT ... RETURNING id：PG 原生支持，直接透传。
// - 业务 SQL 里 `RETURNING *`/`RETURNING col` 的 SELECT 形态走原生。
//
// 事务：D1.batch 语义是全成功或全失败——对应 PG 事务。postgres.js 的
// sql.begin 提供了该语义，但 D1 语句是逐条 prepare 的，这里用连接级
// BEGIN/COMMIT 保证与 SQLite 适配器一致的执行模型。

import postgres, { type Sql, type TransactionSql, type Row, type Parameter } from 'postgres';
import { rewriteSql } from './rewrite.ts';
import type { D1Result } from './types.ts';

/** PIGEON_SQL_DEBUG：失败语句与参数打到 stderr（docs/node-deployment.md 承诺的排障开关） */
function debugFail(tag: string, sql: string, args: readonly unknown[]): void {
  if (!process.env.PIGEON_SQL_DEBUG) return;
  console.error(`${tag} FAIL:`, sql.slice(0, 400), '\nARGS:', JSON.stringify(args).slice(0, 300));
}

export class PostgresD1 {
  readonly #sql: Sql;
  readonly #rewrites = new Map<string, ReturnType<typeof rewriteSql>>();

  constructor(connectionString: string, options?: { max?: number }) {
    this.#sql = postgres(connectionString, {
      max: options?.max ?? 10,
      // 业务代码以 sqlite 风格传参（数字/字符串/null），驱动自动转换
      prepare: false,
      // 存储约定：所有整数列（布尔 0/1、时间戳）都是 BIGINT；postgres.js 默认把
      // int8 解析为 string（防精度丢失），本项目的数值都在安全整数范围内，
      // 且业务代码大量 truthy/全等判断 —— 必须解析回 number
      types: {
        int8: {
          to: 20,
          from: [20],
          serialize: (value: number | string) => String(value),
          parse: (value: string) => Number(value),
        },
      },
    });
  }

  /** 供迁移执行器直接执行 DDL 脚本 */
  get raw(): Sql {
    return this.#sql;
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    try {
      await this.#sql.unsafe(query);
    } catch (error) {
      debugFail('PG EXEC', query, []);
      throw error;
    }
    return { count: 0, duration: performance.now() - started };
  }

  prepare(query: string): PostgresPreparedStatement {
    return new PostgresPreparedStatement(this, query);
  }

  async batch<T = unknown>(statements: readonly PostgresPreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    // sql.begin 回调里的 client 与外部连接同池但独占会话：所有语句在
    // 同一事务、同一会话内执行，prevChanges/prevRowId 在语句间传递，
    // 模拟 SQLite batch 的 changes()/last_insert_rowid() 语义。
    await this.#sql.begin(async client => {
      let prevChanges = 0;
      let prevRowId = 0;
      for (const statement of statements) {
        if (!(statement instanceof PostgresPreparedStatement) || statement.owner !== this) {
          throw new TypeError('batch 只接受同一适配器实例 prepare 出的语句');
        }
        const result = await this.#executeWith<T>(client, statement, prevChanges, prevRowId);
        results.push(result);
        prevChanges = result.meta.changes ?? 0;
        prevRowId = result.meta.last_row_id ?? 0;
      }
    });
    return results;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }

  #rewrite(query: string) {
    let rewritten = this.#rewrites.get(query);
    if (!rewritten) {
      rewritten = rewriteSql(query, 'postgres');
      this.#rewrites.set(query, rewritten);
    }
    return rewritten;
  }

  /**
   * rewrite 后 SQL 仍用 ? 占位；PG 需要 $n —— 按 plan 槽位顺序替换。
   * - null 参数：postgres.js 以 text OID 发送 NULL，在 INSERT..SELECT 直入
   *   BIGINT 列时报"column is of type bigint but expression is of type text"。
   *   因此 null 不参数化，直接内联 SQL NULL 字面量并重排 $n。
   * - IS [NOT] NULL 右侧的参数处于纯布尔上下文，PG 无法推断类型（42P18），
   *   显式标注 ::text（NULL 语义不受影响）。
   */
  #toPositional(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
    let paramIndex = 0;
    let nextPlaceholder = 1;
    const finalArgs: unknown[] = [];
    let result = '';
    let idx = 0;
    let inString = false;
    while (idx < sql.length) {
      const ch = sql[idx]!;
      if (ch === "'") { inString = !inString; result += ch; idx++; continue; }
      if (inString) { result += ch; idx++; continue; }
      if (ch === '?') {
        paramIndex++;
        const value = args[paramIndex - 1];
        if (value === null || value === undefined) {
          result += 'NULL';
        } else {
          const n = nextPlaceholder++;
          finalArgs.push(value);
          result += '$' + n;
        }
        idx++;
        continue;
      }
      result += ch;
      idx++;
    }
    // IS [NOT] NULL 上下文：布尔语境中 PG 推断不出参数类型，标注 ::text
    result = result.replace(/[$](\d+)\s+IS\s+(NOT\s+)?NULL/gi, (_m: string, n: string, not?: string) => {
      return '$' + n + '::text IS ' + (not ?? '') + 'NULL';
    });
    return { sql: result, args: finalArgs };
  }

  #positional(plan: ReturnType<typeof rewriteSql>['plan'], values: readonly unknown[], prevChanges: number, prevRowId: number): unknown[] {
    const args: unknown[] = [];
    let vi = 0;
    for (const slot of plan) {
      if (slot.kind === 'value') args.push(values[vi++]);
      else if (slot.kind === 'changes') args.push(prevChanges);
      else args.push(prevRowId);
    }
    return args;
  }

  async #executeWith<T>(client: Sql | TransactionSql, statement: PostgresPreparedStatement, prevChanges: number, prevRowId: number): Promise<D1Result<T>> {
    const plan = this.#rewrite(statement.query);
    const args = this.#positional(plan.plan, statement.params, prevChanges, prevRowId) as Parameter[];
    const positional = this.#toPositional(plan.sql, args);
    const isWrite = /^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(statement.query);
    if (isWrite) {
      // PG 无 changes() 函数：写语句统一走 unsafe + count。带原生
      // RETURNING 的语句 rows 即结果行。
      let result: { count: number; rows: Row[] };
      try {
        result = (await client.unsafe(positional.sql, positional.args as Parameter[])) as unknown as { count: number; rows: Row[] };
      } catch (error) {
        debugFail('PG BATCH', positional.sql, positional.args);
        throw error;
      }
      const changes = result.count;
      const rows = (Array.isArray(result) ? result : result.rows) as T[];
      const lastRowId = (rows[0] as { id?: number } | undefined)?.id ?? prevRowId;
      const out: D1Result<T> = { success: true, meta: { changes, last_row_id: lastRowId } };
      if (rows.length) out.results = rows;
      return out;
    }
    let result: { rows: Row[] };
    try {
      result = (await client.unsafe(positional.sql, positional.args as Parameter[])) as unknown as { rows: Row[] };
    } catch (error) {
      debugFail('PG SELECT', positional.sql, positional.args);
      throw error;
    }
    return { results: ((Array.isArray(result) ? result : result.rows) as T[]), success: true, meta: {} };
  }

  /** @internal */
  async _run<T>(statement: PostgresPreparedStatement): Promise<D1Result<T>> {
    const plan = this.#rewrite(statement.query);
    const args = this.#positional(plan.plan, statement.params, 0, 0) as Parameter[];
    const positional = this.#toPositional(plan.sql, args);
    const isWrite = /^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(statement.query);
    if (isWrite) {
      let result: { count: number; rows: Row[] };
      try {
        result = (await this.#sql.unsafe(positional.sql, positional.args as Parameter[])) as unknown as { count: number; rows: Row[] };
      } catch (error) {
        debugFail('PG WRITE', positional.sql, positional.args);
        throw error;
      }
      const writeRows = (Array.isArray(result) ? result : result.rows) as T[];
      const lastRowId = (writeRows[0] as { id?: number } | undefined)?.id ?? 0;
      const out: D1Result<T> = { success: true, meta: { changes: result.count, last_row_id: lastRowId } };
      if (writeRows.length) out.results = writeRows;
      return out;
    }
    let result: { rows: Row[] };
    try {
      result = (await this.#sql.unsafe(positional.sql, positional.args as Parameter[])) as unknown as { rows: Row[] };
    } catch (error) {
      debugFail('PG SELECT', positional.sql, positional.args);
      throw error;
    }
    return { results: ((Array.isArray(result) ? result : result.rows) as T[]), success: true, meta: {} };
  }

  /** @internal */
  async _first<T>(statement: PostgresPreparedStatement): Promise<T | null> {
    const result = await this._run<T>(statement);
    return (result.results?.[0] as T | undefined) ?? null;
  }
}

export class PostgresPreparedStatement {
  readonly owner: PostgresD1;
  /** @internal */
  readonly query: string;
  #params: readonly unknown[] = [];

  constructor(owner: PostgresD1, query: string) {
    this.owner = owner;
    this.query = query;
  }

  bind(...values: unknown[]): this {
    this.#params = values;
    return this;
  }

  get params(): readonly unknown[] {
    return this.#params;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = await this.owner._first<T>(this);
    if (!row || colName === undefined) return row;
    return ((row as Record<string, unknown>)[colName] as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return this.owner._run<T>(this);
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.owner._run<T>(this);
  }

  async raw<T = unknown>(options?: { columnNames?: boolean }): Promise<unknown[]> {
    const result = await this.owner._run<T>(this);
    const rows = (result.results ?? []) as Record<string, unknown>[];
    if (options?.columnNames) {
      const names = rows.length ? Object.keys(rows[0]!) : [];
      return [names, ...rows.map(row => Object.values(row))];
    }
    return rows.map(row => Object.values(row));
  }
}
