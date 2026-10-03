// @pigeon-skin/db —— D1 类型化访问入口。
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema.ts';

export * from './schema.ts';

/** D1 binding 的最小形状，避免依赖 @cloudflare/workers-types */
export interface D1Like {
  prepare(query: string): unknown;
  batch?(statements: unknown[]): Promise<unknown[]>;
  exec?(query: string): Promise<unknown>;
}

/**
 * 由 D1 binding 构造 Drizzle 实例。
 *
 * 用法：`const db = createDb(env.DB)`，然后 `db.select().from(users)...`
 */
export function createDb(d1: D1Database): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(d1, { schema });
}

/** 让 TypeScript 认识 D1Database 而无需引入完整的 workers-types */
export type D1Database = Parameters<typeof drizzle>[0];

export { schema };
