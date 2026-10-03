// SQLite 源适配器 —— 用 Node 内置的 node:sqlite，零依赖。
//
// 旧 Blessing Skin 支持 MySQL/MariaDB/PostgreSQL/SQLite 四种后端，
// 其中 SQLite 部署最常见于小型自建站，也是最容易在本地做迁移演练的一种。
import { normalizeColumnKind, type ColumnInfo, type SourceAdapter } from './types.ts';

// 用 process.getBuiltinModule 而不是 import/require：
// Vite/Vitest 的 SSR 外部化列表不认识较新的 node 内置模块，它会把 `node:sqlite`
// 剥成 `sqlite` 再按包名解析，然后失败；而 createRequire 又会被 SSR 转换改写。
// getBuiltinModule 对打包器完全不透明，且正是为这种场景提供的。
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** 因为 DatabaseSync 是从 getBuiltinModule 取到的值，这里要用 InstanceType 取出实例类型 */
type Database = InstanceType<typeof DatabaseSync>;

export interface SqliteSourceOptions {
  readonly path: string;
  /** 只读打开。迁移工具绝不写源库。 */
  readonly readOnly?: boolean;
}

export class SqliteSource implements SourceAdapter {
  readonly kind = 'sqlite' as const;
  readonly describe: string;
  readonly #db: Database;

  constructor(opts: SqliteSourceOptions) {
    // 默认只读：迁移是对源库的纯读操作，用 readOnly 从驱动层强制这一点
    this.#db = new DatabaseSync(opts.path, { readOnly: opts.readOnly ?? true });
    this.describe = `sqlite://${opts.path}`;
  }

  async listTables(): Promise<string[]> {
    const rows = this.#db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async columns(table: string): Promise<ColumnInfo[] | null> {
    // PRAGMA 不支持绑定参数，所以只能拼接；表名来自 sqlite_master，不是用户输入。
    // 仍然做一次白名单校验，避免任何拼接口子。
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`非法表名: ${table}`);
    }
    let rows: Array<{ name: string; type: string | null; notnull: number; dflt_value: string | null }>;
    try {
      rows = this.#db.prepare(`PRAGMA table_info("${table}")`).all() as typeof rows;
    } catch {
      return null;
    }
    if (rows.length === 0) return null;
    return rows.map((r) => ({
      name: r.name,
      kind: normalizeColumnKind(r.type),
      notNull: r.notnull === 1,
      defaultValue: r.dflt_value,
    }));
  }

  async count(table: string): Promise<number> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`非法表名: ${table}`);
    }
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.#db.prepare(sql).all(...(params as never[])) as T[];
  }

  async scalar<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
    const row = this.#db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    const first = Object.values(row)[0];
    return (first ?? null) as T | null;
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
