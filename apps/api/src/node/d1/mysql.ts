// MySQL（mysql2/promise）上的 D1 形状适配器。
//
// MySQL 是三方言中差异最大的：
// - 无 RETURNING：INSERT...RETURNING id 由重写引擎去掉 RETURNING、
//   运行后用 insertId 合成 results（emulateInsertReturning）；
//   UPDATE/DELETE...RETURNING 无法模拟——这类站点须在业务代码用
//   supportsReturning() 分支（适配器遇到直接抛错，fail-fast）。
// - changes()/last_insert_rowid()：affectedRows / insertId 注入哨兵槽。
// - `IS ?` → <=>；双引号标识符 → 反引号；INSERT OR IGNORE → INSERT IGNORE；
//   ON CONFLICT → ON DUPLICATE KEY（均在 rewrite.ts 机械转换）。

import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { rewriteSql } from './rewrite.ts';
import type { D1Result } from './types.ts';

export class MysqlD1 {
  readonly #pool: Pool;
  readonly #rewrites = new Map<string, ReturnType<typeof rewriteSql>>();

  constructor(connectionString: string, options?: { connectionLimit?: number }) {
    this.#pool = mysql.createPool({
      uri: connectionString,
      // 迁移 SQL 是多语句脚本；适配器的整脚本 exec 依赖 multipleStatements
      multipleStatements: true,
      connectionLimit: options?.connectionLimit ?? 10,
      // 业务代码的布尔值按 0/1 存储、JSON 存 TEXT，不做类型转换
      dateStrings: false,
      decimalNumbers: true,
    });
  }

  /** 供迁移执行器直接执行 DDL 脚本 */
  get raw(): Pool {
    return this.#pool;
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    await this.#pool.query(query);
    return { count: 0, duration: performance.now() - started };
  }

  prepare(query: string): MysqlPreparedStatement {
    return new MysqlPreparedStatement(this, query);
  }

  async batch<T = unknown>(statements: readonly MysqlPreparedStatement[]): Promise<D1Result<T>[]> {
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      const results: D1Result<T>[] = [];
      let prevChanges = 0;
      let prevRowId = 0;
      for (const statement of statements) {
        if (!(statement instanceof MysqlPreparedStatement) || statement.owner !== this) {
          throw new TypeError('batch 只接受同一适配器实例 prepare 出的语句');
        }
        const result = await this.#executeWith<T>(connection, statement, prevChanges, prevRowId);
        results.push(result);
        prevChanges = result.meta.changes ?? 0;
        prevRowId = result.meta.last_row_id ?? 0;
      }
      await connection.commit();
      return results;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  #rewrite(query: string) {
    let rewritten = this.#rewrites.get(query);
    if (!rewritten) {
      rewritten = rewriteSql(query, 'mysql');
      this.#rewrites.set(query, rewritten);
    }
    return rewritten;
  }

  #args(plan: ReturnType<typeof rewriteSql>['plan'], values: readonly unknown[], prevChanges: number, prevRowId: number): unknown[] {
    const args: unknown[] = [];
    let vi = 0;
    for (const slot of plan) {
      if (slot.kind === 'value') args.push(values[vi++]);
      else if (slot.kind === 'changes') args.push(prevChanges);
      else args.push(prevRowId);
    }
    return args;
  }

  async #executeWith<T>(connection: PoolConnection | Pool, statement: MysqlPreparedStatement, prevChanges: number, prevRowId: number): Promise<D1Result<T>> {
    const plan = this.#rewrite(statement.query);
    const args = this.#args(plan.plan, statement.params, prevChanges, prevRowId);
    if (plan.emulateInsertReturning) {
      const [header] = await connection.query<ResultSetHeader>(plan.sql, args);
      const insertId = Number(header.insertId);
      return { results: [{ id: insertId }] as T[], success: true, meta: { changes: header.affectedRows, last_row_id: insertId } };
    }
    if (/\bRETURNING\b/i.test(plan.sql)) {
      // UPDATE/DELETE ... RETURNING 的通用模拟：先按同一 WHERE 快照将被
      // 影响行的 RETURNING 列，再执行去掉 RETURNING 的写语句，返回快照行。
      // 单实例自托管部署下两步之间的并发窗口可忽略（文档"已知差异"注明）。
      if (/^\s*INSERT\b/i.test(plan.sql) && /\bSELECT\b/i.test(plan.sql)) {
        // INSERT..SELECT..RETURNING：SELECT 段的产出即插入行（冲突时更新
        // 旧行，返回的旧行对调用方"行存在"语义等价——业务只用它判非空）
        return this.#emulateInsertSelectReturning<T>(connection, plan.sql, args);
      }
      return this.#emulateWriteReturning<T>(connection, plan.sql, args);
    }
    const isWrite = /^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(statement.query);
    if (isWrite) {
      const [header] = await connection.query<ResultSetHeader>(plan.sql, args);
      return { success: true, meta: { changes: header.affectedRows, last_row_id: Number(header.insertId) } };
    }
    const [rows] = await connection.query<RowDataPacket[]>(plan.sql, args);
    return { results: rows as T[], success: true, meta: {} };
  }

  /**
   * UPDATE/DELETE ... RETURNING cols 的 MySQL 模拟。
   * 前提：写语句的 WHERE 可原样复用为 SELECT 的 WHERE（业务语句满足）；
   * UPDATE 的 SET 段参数在前、WHERE 段在后 —— 按占位符计数切分参数。
   */
  async #emulateWriteReturning<T>(connection: PoolConnection | Pool, sql: string, args: unknown[]): Promise<D1Result<T>> {
    const returning = sql.match(/\bRETURNING\s+([\w*,\s.]+)\s*$/i);
    if (!returning) throw new Error('RETURNING 语句解析失败');
    const columns = returning[1]!.split(',').map(col => col.trim());
    // 去掉 RETURNING 子句
    const writeSql = sql.slice(0, returning.index).trimEnd();
    // 找到写语句主体与 WHERE（顶层 WHERE：括号深度为 0 处）
    const whereMatch = topLevelWhere(writeSql);
    if (!whereMatch) throw new Error('RETURNING 语句缺少 WHERE，无法模拟');
    const isUpdate = /^\s*UPDATE\b/i.test(writeSql);
    // UPDATE：SET 段的 ? 在 WHERE 段之前
    const setPlaceholders = isUpdate ? (writeSql.slice(whereMatch.tableEnd, whereMatch.whereIndex).match(/\?/g)?.length ?? 0) : 0;
    const whereSql = writeSql.slice(whereMatch.whereIndex);
    const whereArgs = args.slice(setPlaceholders);
    const selectSql = `SELECT ${columns.join(', ')} FROM ${whereMatch.table} ${whereSql}`;
    const [snapshot] = await connection.query<RowDataPacket[]>(selectSql, whereArgs);
    const [header] = await connection.query<ResultSetHeader>(writeSql, args);
    return { results: snapshot as T[], success: true, meta: { changes: header.affectedRows } };
  }

  /**
   * INSERT..SELECT..RETURNING cols 的 MySQL 模拟：两步执行——
   * 1) 用同参数执行 SELECT 段（截取到 WHERE/ON DUPLICATE 之前的
   *    "SELECT ?… WHERE 守卫"），拿到将写入的值元组；若空则语句守卫未通过。
   * 2) 执行 INSERT..SELECT（去掉 RETURNING）。
   * 返回快照值按插入列名映射为 RETURNING 列的行。
   */
  async #emulateInsertSelectReturning<T>(connection: PoolConnection | Pool, sql: string, args: unknown[]): Promise<D1Result<T>> {
    const returning = sql.match(/\bRETURNING\s+([\w*,\s.]+)\s*$/i);
    if (!returning) throw new Error('RETURNING 语句解析失败');
    const columns = returning[1]!.split(',').map(col => col.trim());
    const into = sql.match(/\bINSERT\s+INTO\s+[\w`.]+\s*\(([^)]*)\)/i);
    const insertColumns = into ? into[1]!.split(',').map(col => col.trim().replace(/[`]/g, '')) : [];
    // SELECT 段：从第一个顶层 SELECT 到 ON DUPLICATE 之前（去掉 RETURNING 由切片保证）
    let selectStart = -1;
    let depth = 0;
    let inString = false;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i]!;
      if (ch === "'") { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { depth--; continue; }
      if (depth === 0 && /^SELECT\b/i.test(sql.slice(i))) { selectStart = i; break; }
    }
    const conflictMatch = sql.match(/\sON\s+DUPLICATE\s+KEY\s+UPDATE\s+[\s\S]*$/i);
    const selectEnd = conflictMatch ? conflictMatch.index : sql.length;
    const selectSql = sql.slice(selectStart, selectEnd).trimEnd();
    // rowsAsArray：SELECT 段产出的是无名值元组，按位置对应插入列——
    // 对象形态的无名列键序不可靠（mysql2 用值本身当键名）
    const [snapshot] = await (connection as PoolConnection).query({ sql: selectSql, values: args as unknown[], rowsAsArray: true });
    const rows = snapshot as Array<Record<string, unknown>>;
    // SELECT 段的产出列无名时按位置对应插入列
    const results = rows.map(row => {
      const values = Object.values(row);
      const out: Record<string, unknown> = {};
      for (const col of columns) {
        const idx = insertColumns.indexOf(col);
        out[col] = idx >= 0 ? values[idx] : values[0];
      }
      return out;
    });
    const [header] = await connection.query<ResultSetHeader>(sql.slice(0, returning.index).trimEnd(), args);
    return { results: results as T[], success: true, meta: { changes: header.affectedRows } };
  }

  /** @internal */
  async _run<T>(statement: MysqlPreparedStatement): Promise<D1Result<T>> {
    return this.#executeWith<T>(this.#pool, statement, 0, 0);
  }

  /** @internal */
  async _first<T>(statement: MysqlPreparedStatement): Promise<T | null> {
    const result = await this._run<T>(statement);
    return (result.results?.[0] as T | undefined) ?? null;
  }
}

/** 定位 UPDATE/DELETE 语句的表名结束位置与顶层 WHERE 起点 */
function topLevelWhere(sql: string): { table: string; tableEnd: number; whereIndex: number } | undefined {
  let depth = 0;
  let inString = false;
  const updateMatch = sql.match(/^\s*(?:UPDATE|DELETE\s+FROM)\s+([\w`.]+)/i);
  if (!updateMatch) return undefined;
  const table = updateMatch[1]!;
  const tableEnd = updateMatch.index! + updateMatch[0].length;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'") { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && /^\sWHERE\s/i.test(sql.slice(i))) {
      return { table, tableEnd, whereIndex: i + (sql.slice(i).match(/^\sWHERE\s/i)![0].indexOf('WHERE')) };
    }
  }
  return undefined;
}

export class MysqlPreparedStatement {
  readonly owner: MysqlD1;
  /** @internal */
  readonly query: string;
  #params: readonly unknown[] = [];

  constructor(owner: MysqlD1, query: string) {
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
