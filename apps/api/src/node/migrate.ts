// Node 侧数据库迁移执行器。
//
// D1 由 wrangler `d1 migrations apply` 应用迁移（Worker 路径不变）；
// Node 路径用这里的执行器把 packages/db/migrations*.sql 回放到本地
// 数据库，并在迁移表里记账。SQLite 与 PG/MySQL 共用这个入口，方言
// 迁移目录不同（migrations / migrations-pg / migrations-mysql）。
//
// SQLite 迁移 SQL 是多语句脚本（含 CREATE TRIGGER），node:sqlite 的
// exec() 支持多语句，直接整脚本执行；DDL 隐式提交无法回滚，因此按
// "逐脚本执行 + 记账"推进，与 D1 的行为一致。
// PG/MySQL 通过驱动自身的 query 执行整脚本（postgres.js 的 unsafe 与
// mysql2 的 multipleStatements 均支持多语句；两方言的迁移 SQL 已避免
// 依赖 DELIMITER 或 dollar-quoting 的多语句歧义）。

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqliteD1 } from './d1/sqlite.ts';
import type { PostgresD1 } from './d1/postgres.ts';
import type { MysqlD1 } from './d1/mysql.ts';

/** 迁移目录解析：源码运行时相对本文件；bundle 后相对仓库根（用 PIGEON_ROOT 或 cwd 探测） */
function migrationsDir(dialect: 'sqlite' | 'postgres' | 'mysql'): string {
  const relative = dialect === 'sqlite' ? 'packages/db/migrations' : dialect === 'postgres' ? 'packages/db/migrations-pg' : 'packages/db/migrations-mysql';
  const candidates = [
    process.env.PIGEON_ROOT ? join(process.env.PIGEON_ROOT, relative) : undefined,
    // 源码路径：apps/api/src/node → 仓库根上三级
    join(dirname(fileURLToPath(import.meta.url)), '../../../..', relative),
    join(process.cwd(), relative),
    join(process.cwd(), '../..', relative),
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch { /* 下一个候选 */ }
  }
  throw new Error(`找不到迁移目录（${relative}），可设 PIGEON_ROOT 指向仓库根`);
}

export function listMigrations(dialect: 'sqlite' | 'postgres' | 'mysql'): Array<{ name: string; sql: string }> {
  const dir = migrationsDir(dialect);
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  return files.map(name => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

interface MigrationRecorder {
  ensureTable(): Promise<void>;
  appliedIds(): Promise<Set<string>>;
  record(id: string): Promise<void>;
}

function sqliteRecorder(d1: SqliteD1): MigrationRecorder {
  return {
    async ensureTable() {
      await d1.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
    },
    async appliedIds() {
      const rows = (await d1.prepare('SELECT id FROM d1_migrations').all<{ id: string }>()).results ?? [];
      return new Set(rows.map(row => row.id));
    },
    async record(id) {
      await d1.prepare('INSERT INTO d1_migrations (id, applied_at) VALUES (?, ?)').bind(id, Date.now()).run();
    },
  };
}

function pgRecorder(d1: PostgresD1): MigrationRecorder {
  return {
    async ensureTable() {
      await d1.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
    },
    async appliedIds() {
      // postgres.js tagged template 直接返回行数组（非 { rows } 包装）
      const rows = (await d1.raw`SELECT id FROM d1_migrations`) as unknown as Array<{ id: string }>;
      return new Set(rows.map(row => row.id));
    },
    async record(id) {
      await d1.raw`INSERT INTO d1_migrations (id, applied_at) VALUES (${id}, ${Date.now()})`;
    },
  };
}

function mysqlRecorder(d1: MysqlD1): MigrationRecorder {
  return {
    async ensureTable() {
      await d1.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id VARCHAR(512) PRIMARY KEY, applied_at BIGINT NOT NULL)');
    },
    async appliedIds() {
      const [rows] = (await d1.raw.query('SELECT id FROM d1_migrations')) as [Array<{ id: string }>, unknown];
      return new Set(rows.map(row => row.id));
    },
    async record(id) {
      await d1.raw.query('INSERT INTO d1_migrations (id, applied_at) VALUES (?, ?)', [id, Date.now()]);
    },
  };
}

async function applyMigrations(d1: SqliteD1 | PostgresD1 | MysqlD1, dialect: 'sqlite' | 'postgres' | 'mysql', recorder: MigrationRecorder): Promise<void> {
  await recorder.ensureTable();
  const applied = await recorder.appliedIds();
  for (const migration of listMigrations(dialect)) {
    if (applied.has(migration.name)) continue;
    await d1.exec(migration.sql);
    await recorder.record(migration.name);
    console.log(`migration applied: ${migration.name}`);
  }
}

export async function runMigrationsForNode(d1: SqliteD1): Promise<void> {
  await applyMigrations(d1, 'sqlite', sqliteRecorder(d1));
}

export async function runMigrationsPostgres(d1: PostgresD1): Promise<void> {
  await applyMigrations(d1, 'postgres', pgRecorder(d1));
}

export async function runMigrationsMysql(d1: MysqlD1): Promise<void> {
  // mysql2 需要多语句支持才能整脚本执行迁移
  await applyMigrations(d1, 'mysql', mysqlRecorder(d1));
}
