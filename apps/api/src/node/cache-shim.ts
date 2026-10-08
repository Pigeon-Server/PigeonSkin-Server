// Cache API（caches.default）的 Node 侧 SQLite 模拟。
//
// 业务代码的实际用法（grep 全仓确认，只实现用到的子集）：
//   • match(request: Request | string) → Response | undefined
//     （sitemap.ts/protocol.ts/yggdrasil.ts 传 Request；
//     services/sitemap-cache.ts 传字符串键 'https://sitemap.internal/__version__'）
//   • put(request: Request | string, response: Response)
//     （yggdrasil.ts put 字符串 cacheKey；sitemap-cache.ts 同）
//   • delete(request: Request | string) → boolean
//     （texture-access.ts 传 new Request(url)，用 .catch(() => false)）
// 不实现 TTL 淘汰与 Vary 协商——业务代码不依赖。
//
// installCacheShim 通过 Object.defineProperty 写 globalThis.caches：
// workers-types 把 caches 声明为全局，直接赋值过不了类型检查；运行时
// 业务代码裸引用 `caches.default`，defineProperty 后即可命中。

import { DatabaseSync, type DatabaseSyncLike, type StatementSync } from './sqlite-shim.ts';

export interface CacheShimOptions {
  /** node:sqlite 文件路径（:memory: 亦可） */
  path: string;
  /** 复用已打开的连接；否则按 path 自行打开 */
  db?: DatabaseSyncLike;
}

/** Cache API 的 request 形状：Request 实例或字符串 URL 键 */
type CacheKeyInput = Request | string;

/** 归一化成 URL 字符串键：Request → request.url，字符串原样 */
function toKey(request: CacheKeyInput): string {
  return typeof request === 'string' ? request : request.url;
}

interface CacheRow {
  url: string;
  status: number;
  headers: string;
  body: Uint8Array;
}

export class CacheShim {
  readonly #db: DatabaseSyncLike;
  readonly #stmts = new Map<string, StatementSync>();
  readonly #ownsDb: boolean;

  constructor(options: CacheShimOptions) {
    this.#ownsDb = options.db === undefined;
    this.#db = options.db ?? new DatabaseSync(options.path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS cache_entries (
      url TEXT PRIMARY KEY,
      status INTEGER NOT NULL,
      headers TEXT NOT NULL,
      body BLOB NOT NULL,
      stored_at INTEGER NOT NULL
    )`);
  }

  async match(request: CacheKeyInput): Promise<Response | undefined> {
    const row = this.#select(toKey(request));
    if (row === undefined) return undefined;
    const headers = new Headers(JSON.parse(row.headers) as [string, string][]);
    return new Response(toArrayBuffer(row.body), { status: Number(row.status), headers });
  }

  async put(request: CacheKeyInput, response: Response): Promise<void> {
    const body = new Uint8Array(await response.arrayBuffer());
    const headers: [string, string][] = [...response.headers.entries()];
    this.#stmt(`INSERT OR REPLACE INTO cache_entries (url, status, headers, body, stored_at) VALUES (?, ?, ?, ?, ?)`)
      .run(...([toKey(request), response.status, JSON.stringify(headers), body, Date.now()] as never[]));
  }

  async delete(request: CacheKeyInput): Promise<boolean> {
    const info = this.#stmt('DELETE FROM cache_entries WHERE url = ?').run(...([toKey(request)] as never[]));
    return Number(info.changes) > 0;
  }

  /** 清空全部缓存条目（测试与运维用；Workers Cache API 无对应方法） */
  clear(): void {
    this.#stmt('DELETE FROM cache_entries').run();
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }

  #select(url: string): CacheRow | undefined {
    return this.#stmt('SELECT url, status, headers, body FROM cache_entries WHERE url = ?')
      .get(...([url] as never[])) as CacheRow | undefined;
  }

  #stmt(sql: string): StatementSync {
    let stmt = this.#stmts.get(sql);
    if (stmt === undefined) {
      stmt = this.#db.prepare(sql);
      this.#stmts.set(sql, stmt);
    }
    return stmt;
  }
}

/** Cache 实例的结构形状（Redis 驱动 cache-redis.ts 复用同一接口装配） */
export interface CacheLike {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
  delete(request: Request | string): Promise<boolean>;
}

/** CacheStorage 形状：业务代码只用 caches.default */
export interface CacheStorageShim {
  default: CacheLike;
}

/** Uint8Array → 独立 ArrayBuffer（Response body 需要完整缓冲） */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

/**
 * 把 CacheStorage 形状装到 globalThis.caches 上。用 defineProperty 是因为
 * workers-types 已将 caches 声明为只读全局；运行时业务代码裸引用
 * `caches.default`，装完即命中。cache-redis.ts 的 Redis 驱动复用同一装配。
 */
export function installCacheStorage(storage: CacheStorageShim): CacheStorageShim {
  Object.defineProperty(globalThis, 'caches', {
    value: storage,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return storage;
}

export function installCacheShim(options: CacheShimOptions): CacheShim {
  const shim = new CacheShim(options);
  installCacheStorage({ default: shim });
  return shim;
}
