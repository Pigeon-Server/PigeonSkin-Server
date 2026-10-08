// 数据库适配器工厂：按 DB_DRIVER 构造 D1 形状适配器。
//
// 三个实现都满足 D1Database 的结构形状（prepare/batch/exec），
// 因此 packages/db 的 createDb() 可以直接包住它们，Drizzle 查询
// 与裸 SQL 业务代码无需感知运行在哪个数据库上。

import { setDialect, type Dialect } from '@pigeon-skin/db';
import { SqliteD1 } from './sqlite.ts';
import { PostgresD1 } from './postgres.ts';
import { MysqlD1 } from './mysql.ts';

export type { D1Meta, D1Result } from './types.ts';
export { SqliteD1 } from './sqlite.ts';
export { PostgresD1 } from './postgres.ts';
export { MysqlD1 } from './mysql.ts';

export type AnyD1 = SqliteD1 | PostgresD1 | MysqlD1;

export interface DatabaseOptions {
  driver: 'sqlite' | 'postgres' | 'mysql';
  /** sqlite 的文件路径（或 ':memory:'） */
  path?: string | undefined;
  /** PG/MySQL 的连接串 */
  url?: string | undefined;
}

export function createDatabase(options: DatabaseOptions): AnyD1 {
  setDialect(options.driver as Dialect);
  if (options.driver === 'sqlite') {
    if (!options.path) throw new Error('DB_DRIVER=sqlite 需要 DATABASE_PATH');
    return new SqliteD1({ path: options.path });
  }
  if (!options.url) throw new Error(`DB_DRIVER=${options.driver} 需要 DATABASE_URL`);
  if (options.driver === 'postgres') return new PostgresD1(options.url);
  return new MysqlD1(options.url);
}
