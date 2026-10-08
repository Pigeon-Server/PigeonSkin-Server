// MySQL 直连源 —— 实现 tools/migrate 的 SourceAdapter 接口（mysql2/promise）。
// 只用只读查询；凭据来自旧站 .env，不写入任何持久文件。

import type { SourceAdapter, ColumnInfo } from '@pigeon-skin/migrate/src/sources/types';

export interface MysqlConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

interface MysqlPoolLike {
  query<T>(sql: string, params?: unknown[]): Promise<[T[], unknown]>;
  execute<T>(sql: string, params: unknown[]): Promise<[T[], unknown]>;
  end(): Promise<void>;
}

export async function openMysqlSource(opts: MysqlConnectOptions): Promise<SourceAdapter> {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({
    host: opts.host,
    port: opts.port,
    database: opts.database,
    user: opts.user,
    password: opts.password,
    connectionLimit: 2,
    // 旧库时间戳按 DATETIME 字符串读出，不做时区换算（mapper 负责时区语义）
    timezone: 'Z',
    dateStrings: true,
    connectTimeout: 8000,
  }) as unknown as MysqlPoolLike;

  // 连接即验证：给用户即时的错误而不是第一批查询时才炸
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    await pool.end().catch(() => {});
    throw new Error(`无法连接旧站 MySQL ${opts.user}@${opts.host}:${opts.port}/${opts.database}: ${(e as Error).message}`, { cause: e });
  }

  const run = async <T>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
    // mysql2 的 query() 遇到无参数调用不会做占位符替换，而 pageLoop 传的是
    // 带 ? 占位符的 SQL + params（LIMIT ? OFFSET ?），因此统一走 execute
    const [rows] = params && params.length > 0
      ? await pool.execute<T>(sql, params as unknown[])
      : await pool.query<T>(sql);
    return rows as T[];
  };

  return {
    kind: 'mysql',
    describe: `MySQL ${opts.user}@${opts.host}:${opts.port}/${opts.database}`,

    async listTables() {
      const rows = await run<{ TABLE_NAME: string }>(
        'SELECT TABLE_NAME AS TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
      );
      return rows.map((r) => String(r.TABLE_NAME));
    },

    async columns(table) {
      // information_schema 元数据查询不接受用户输入拼接以外的表名 —— 表名来自代码白名单
      const rows = await run<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: 'YES' | 'NO'; COLUMN_DEFAULT: string | null }>(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table.replace(/'/g, "''")}'
         ORDER BY ORDINAL_POSITION`,
      );
      if (rows.length === 0) return null;
      return rows.map((r): ColumnInfo => ({
        name: String(r.COLUMN_NAME),
        kind: normalizeMysqlType(String(r.DATA_TYPE)),
        notNull: r.IS_NULLABLE === 'NO',
        defaultValue: r.COLUMN_DEFAULT === null ? null : String(r.COLUMN_DEFAULT),
      }));
    },

    async count(table) {
      const rows = await run<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${table}\``);
      return Number(rows[0]?.n ?? 0);
    },

    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      return run<T>(sql, params);
    },

    async scalar<T = unknown>(sql: string) {
      const rows = await run<Record<string, unknown>>(sql);
      const first = rows[0];
      if (!first) return null;
      const v = Object.values(first)[0];
      return (v ?? null) as T | null;
    },

    async close() {
      await pool.end();
    },
  };
}

function normalizeMysqlType(declared: string): ColumnInfo['kind'] {
  const t = declared.toLowerCase();
  if (/(int|serial|bool)/.test(t)) return 'integer';
  if (/(text|char|enum|set|json)/.test(t)) return 'text';
  if (/(decimal|numeric|float|double|real)/.test(t)) return 'real';
  if (/(blob|binary)/.test(t)) return 'blob';
  if (/(date|time)/.test(t)) return 'text';
  return 'unknown';
}
