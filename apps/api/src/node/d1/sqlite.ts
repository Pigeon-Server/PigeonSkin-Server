// node:sqlite 上的 D1 形状适配器。
//
// node:sqlite 是同步 API；D1 的接口全是异步的。对单机 SQLite 而言同步
// 执行就是最快路径——异步壳只做 Promise 包装。WAL + busy_timeout 让并发
// 请求在写锁上短暂排队，而不是报错。
//
// SQLite 原生支持 changes()/last_insert_rowid()/IS ?，语句原样透传；
// 哨兵机制（ParamSlot）只在 PG/MySQL 实现里生效。

import { DatabaseSync, type DatabaseSyncLike, type StatementSync } from '../sqlite-shim.ts';
import { rewriteSql, type RewriteResult } from './rewrite.ts';
import type { D1Result } from './types.ts';

export class SqliteD1 {
  readonly #db: DatabaseSyncLike;
  readonly #stmts = new Map<string, StatementSync>();
  readonly #rewrites = new Map<string, RewriteResult>();

  constructor(options: { path: string }) {
    this.#db = new DatabaseSync(options.path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA synchronous = NORMAL');
  }

  /** D1Database.exec 形状（迁移执行器与种子脚本用） */
  async exec(query: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    this.#db.exec(query);
    return { count: 0, duration: performance.now() - started };
  }

  prepare(query: string): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this, query);
  }

  async batch<T = unknown>(statements: readonly SqlitePreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    this.#db.exec('BEGIN');
    try {
      for (const statement of statements) {
        if (!(statement instanceof SqlitePreparedStatement) || statement.owner !== this) {
          throw new TypeError('batch 只接受同一适配器实例 prepare 出的语句');
        }
        results.push(this.#execute<T>(statement.query, statement.params));
      }
      this.#db.exec('COMMIT');
      return results;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw error;
    }
  }

  /** 迁移执行器用：单连接串行执行 DDL */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#db.exec('BEGIN');
    try {
      const value = await fn();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  #rewrite(query: string): RewriteResult {
    let rewritten = this.#rewrites.get(query);
    if (!rewritten) {
      rewritten = rewriteSql(query, 'sqlite');
      this.#rewrites.set(query, rewritten);
    }
    return rewritten;
  }

  #statement(sql: string): StatementSync {
    const cached = this.#stmts.get(sql);
    if (cached) return cached;
    const stmt = this.#db.prepare(sql);
    this.#stmts.set(sql, stmt);
    return stmt;
  }

  #execute<T>(query: string, params: readonly unknown[]): D1Result<T> {
    // sqlite：plan 全 value 槽，哨兵不存在
    const plan = this.#rewrite(query);
    const started = performance.now();
    if (/^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(query)) {
      if (/\bRETURNING\b/i.test(query)) {
        // 写语句带 RETURNING：必须用 all() 执行并回传行——run() 会执行
        // 成功但丢弃 RETURNING 结果行，业务代码读 results[0].id 会拿到
        // undefined（注册接口据此误判"达到注册上限"）
        const rows = this.#statement(plan.sql).all(...(params as never[])) as T[];
        return { results: rows, success: true, meta: { changes: rows.length, duration: performance.now() - started } };
      }
      const info = this.#statement(plan.sql).run(...(params as never[]));
      return {
        success: true,
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid), duration: performance.now() - started },
      };
    }
    const rows = this.#statement(plan.sql).all(...(params as never[])) as T[];
    return { results: rows, success: true, meta: { duration: performance.now() - started } };
  }

  #first<T>(query: string, params: readonly unknown[]): T | null {
    const plan = this.#rewrite(query);
    return (this.#statement(plan.sql).get(...(params as never[])) as T | undefined) ?? null;
  }

  /** @internal */
  _run<T>(statement: SqlitePreparedStatement): D1Result<T> {
    return this.#execute<T>(statement.query, statement.params);
  }

  /** @internal */
  _first<T>(statement: SqlitePreparedStatement): T | null {
    return this.#first<T>(statement.query, statement.params);
  }
}

export class SqlitePreparedStatement {
  readonly owner: SqliteD1;
  /** @internal */
  readonly query: string;
  #params: readonly unknown[] = [];

  constructor(owner: SqliteD1, query: string) {
    this.owner = owner;
    this.query = query;
  }

  bind(...values: unknown[]): this {
    this.#params = values;
    return this;
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

  /** D1 raw 形状：数组的数组（columnNames 时首行为列名） */
  async raw<T = unknown>(options?: { columnNames?: boolean }): Promise<unknown[]> {
    const result = await this.owner._run<T>(this);
    const rows = (result.results ?? []) as Record<string, unknown>[];
    if (options?.columnNames) {
      const names = rows.length ? Object.keys(rows[0]!) : [];
      return [names, ...rows.map(row => Object.values(row))];
    }
    return rows.map(row => Object.values(row));
  }

  get params(): readonly unknown[] {
    return this.#params;
  }
}

// ParamSlot 在 sqlite 适配器恒为 value 槽（无哨兵），显式引用以保类型完整

