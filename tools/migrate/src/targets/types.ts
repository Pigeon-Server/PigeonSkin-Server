// 迁移目标端抽象 —— 新系统侧的写入接口。
//
// 两个实现：
//   • SqliteTarget —— 本地 D1 数据库文件（wrangler d1 导出的 .sqlite，
//     或 `wrangler d1 migrations apply --local` 产生的 miniflare 库）。
//     测试与小站迁移直接用它。
//   • D1HttpTarget —— Cloudflare D1 REST API（大库远程导入）。
//
// 接口刻意窄：只有「批插入」「查询」「应用 schema 脚本」三个动作，
// mapper 不应该有能力做任意 DDL。
//
// 安全边界：所有数据值一律走 SQLite 参数绑定（? 占位符），从不拼接进
// SQL 文本；唯一执行裸 SQL 的地方是 schema 脚本，而那是仓库里的静态文件。

/** 已绑定参数的单条语句。SQL 文本里只允许 ? 占位符。 */
export interface BoundStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface TargetAdapter {
  readonly kind: 'sqlite' | 'd1-http';
  readonly describe: string;

  /**
   * 在一个事务里执行多条已绑定语句；任何一条失败则整体回滚。
   * 返回实际插入的行数（INSERT OR IGNORE 可能静默吞掉违反唯一约束的行，
   * 报告必须反映落库数而不是语句数）。
   */
  runBatch(statements: readonly BoundStatement[]): Promise<number>;

  /** 读取一批行（verify 用） */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  /** 应用 schema 脚本（仅仓库内的静态迁移文件，无外部输入） */
  applySchema(sqlScript: string): Promise<void>;

  close(): Promise<void>;
}

type NodeSqlite = typeof import('node:sqlite');

function nodeSqlite(): NodeSqlite {
  // 与 SqliteSource 同样的原因：getBuiltinModule 对打包器不透明，
  // Vitest 直接 import 'node:sqlite' 会失败。
  return process.getBuiltinModule('node:sqlite') as NodeSqlite;
}

/** 本地 SQLite 目标。事务用显式 BEGIN/COMMIT，数据全部参数绑定。 */
export class SqliteTarget implements TargetAdapter {
  readonly kind = 'sqlite' as const;
  readonly describe: string;

  private readonly db: import('node:sqlite').DatabaseSync;

  private constructor(db: import('node:sqlite').DatabaseSync, path: string) {
    this.db = db;
    this.describe = `sqlite:${path}`;
  }

  static open(path: string): SqliteTarget {
    // 批量导入期间关闭外键约束：users.avatar_texture_id 引用 textures，
    // 而 textures.uploader_id 引用 users —— 互相引用无法用单遍导入满足，
    // 顺序导入（users → textures → players）必然触发 FK 失败。
    // 引用完整性由 verify 命令在导入完成后显式校验，效果等同且可报告。
    return new SqliteTarget(
      new (nodeSqlite().DatabaseSync)(path, { enableForeignKeyConstraints: false }),
      path,
    );
  }

  async runBatch(statements: readonly BoundStatement[]): Promise<number> {
    const begin = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    begin.run();
    try {
      let changes = 0;
      for (const s of statements) {
        const result = this.db.prepare(s.sql).run(...s.params as import('node:sqlite').SQLInputValue[]);
        changes += Number(result.changes ?? 0);
      }
      commit.run();
      return changes;
    } catch (e) {
      rollback.run();
      throw e;
    }
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params as import('node:sqlite').SQLInputValue[]) as T[];
  }

  async applySchema(sqlScript: string): Promise<void> {
    // schema 脚本来自 packages/db/migrations 静态文件，不含任何运行时输入。
    // 语句逐条执行且容忍"已存在"错误 —— CREATE TABLE/INDEX/TRIGGER 的幂等
    // 重入是断点续跑的基础（migrations 文本本身不带 IF NOT EXISTS）。
    for (const stmt of splitStatements(sqlScript)) {
      try {
        this.db.prepare(stmt).run();
      } catch (e) {
        const msg = String(e);
        if (!/already exists/i.test(msg)) throw e;
      }
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * 按 `;` 切分 schema 脚本，但尊重 SQLite 的 BEGIN…END 触发器体：
 * 触发器体内的分号不属于语句边界。注释行剥掉后再判空。不做任何值插值。
 */
function splitStatements(sqlScript: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inTriggerBody = false;

  for (const rawLine of sqlScript.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    // 跳过注释行
    if (trimmed.startsWith('--')) continue;
    // 触发器体从 "BEGIN" 行开始（CREATE TRIGGER ... BEGIN），到单独的 "END;" 结束
    if (!inTriggerBody && /CREATE\s+TRIGGER/i.test(trimmed)) {
      inTriggerBody = true;
      current.push(rawLine);
      continue;
    }
    if (inTriggerBody && /^END\b/i.test(trimmed)) {
      inTriggerBody = false;
      current.push(rawLine);
      out.push(current.join('\n').trim());
      current = [];
      continue;
    }
    if (inTriggerBody) {
      current.push(rawLine); // 体内的分号不是边界
      continue;
    }
    current.push(rawLine);
    if (trimmed.endsWith(';')) {
      const stmt = current.join('\n').trim();
      if (stmt) out.push(stmt);
      current = [];
    }
  }
  const tail = current.join('\n').trim();
  if (tail) out.push(tail);
  return out;
}
