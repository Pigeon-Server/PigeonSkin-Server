// node:sqlite 的运行时加载 shim。
//
// vitest 2.1.9（vite 6.4.3）的 vite-node 无法静态解析 'node:sqlite'
// 内置子路径模块（会剥掉 node: 前缀当 npm 包找），因此适配器改经此
// shim 用 createRequire 动态加载——运行时（Node ≥22.5）真实可用，
// 静态分析器则只看到本模块。esbuild 打包时把本模块标记为 external。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface SqliteError extends Error { code?: string }
export interface StatementSync {
  run(...params: never[]): { changes: number | bigint; lastInsertRowid: number | bigint | undefined };
  all(...params: never[]): unknown[];
  get(...params: never[]): unknown;
}
export interface DatabaseSyncLike {
  exec(query: string): void;
  prepare(query: string): StatementSync;
  close(): void;
}

type DatabaseSyncCtor = new (path: string) => DatabaseSyncLike;

function load(): DatabaseSyncCtor {
  try {
    const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    return mod.DatabaseSync;
  } catch (error) {
    throw new Error(`node:sqlite 不可用（需要 Node ≥22.5）：${(error as SqliteError).message}`, { cause: error });
  }
}

export const DatabaseSync: DatabaseSyncCtor = load();
