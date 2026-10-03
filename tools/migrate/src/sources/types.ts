// 源适配器接口 —— 让 analyze / mapper 不关心旧库是 MySQL、PostgreSQL 还是 SQLite。
//
// 目前只实现 SQLite（node:sqlite，零依赖）。MySQL/PostgreSQL 适配器留到
// 真正需要时再加 —— 本机没有这两种库可测，现在写等于写没验证过的代码。

export interface ColumnInfo {
  readonly name: string;
  /** 归一化后的类型族，避免各家 SQL 方言的类型名差异 */
  readonly kind: 'integer' | 'text' | 'real' | 'blob' | 'unknown';
  readonly notNull: boolean;
  readonly defaultValue: string | null;
}

export interface SourceAdapter {
  /** 适配器名称，用于报告 */
  readonly kind: 'sqlite' | 'mysql' | 'postgres';
  /** 人类可读的连接描述（不含凭据） */
  readonly describe: string;

  /** 列出所有用户表 */
  listTables(): Promise<string[]>;
  /** 列出某张表的列信息；表不存在时返回 null */
  columns(table: string): Promise<ColumnInfo[] | null>;
  /** 行数 */
  count(table: string): Promise<number>;

  /** 读取一批行。大表务必配合 limit/offset 或 keyset 分页，不要一次全取。 */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  /** 执行任意只读 SQL 并取单个标量值 */
  scalar<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T | null>;

  close(): Promise<void>;
}

/** 列类型归一化：各方言 → 统一类型族 */
export function normalizeColumnKind(declared: string | null | undefined): ColumnInfo['kind'] {
  if (!declared) return 'unknown';
  const t = declared.toLowerCase();
  if (/(int|serial|bigint|smallint|tinyint|bool)/.test(t)) return 'integer';
  if (/(char|text|clob|varchar|enum|uuid|json)/.test(t)) return 'text';
  if (/(real|float|double|numeric|decimal)/.test(t)) return 'real';
  if (/(blob|binary|bytea)/.test(t)) return 'blob';
  return 'unknown';
}
