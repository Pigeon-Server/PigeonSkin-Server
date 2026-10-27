// Durable Objects 的 Node 侧 shim：在单进程上模拟 Workers 平台的
// DO 运行时原语，让 src/do/ 下的业务类零改动跑在 Node 上。
//
// 覆盖业务代码实际用到的子集（derivatives.ts / official-resources.ts）：
//   • state.storage.get/put/delete/deleteAll/transaction
//   • state.storage.getAlarm/setAlarm/deleteAlarm
//   • state.blockConcurrencyWhile(fn)、state.waitUntil
//   • namespace.idFromName/idFromString/idToString/get(id)
//
// 与 Workers 的差异（有意为之的简化）：
//   • Workers 的 DO 有 input/output gates + 标签一致性，这里改为同一
//     实例的 fetch/alarm 排队互斥（Promise 链）。
//   • storage 用 JSON 序列化存进 SQLite，值是结构化克隆的近似
//     （ResourceJob 这类纯 JSON 对象足够）；Workers 的 get<T> 泛型在
//     这里退化为 untyped + 调用方断言，与业务代码用法一致。

import { type DatabaseSyncLike as DatabaseSync, type StatementSync } from './sqlite-shim.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

const activeObjects = new AsyncLocalStorage<DurableObjectStateShim>();
const storageOwner = new AsyncLocalStorage<{ db: DatabaseSync; storage: DurableObjectStorageShim; active: boolean }>();
const storageLocks = new WeakMap<DatabaseSync, Promise<void>>();

// ── 存储 ─────────────────────────────────────────────────────────────────────

const ALARM_KEY = '__alarm__';

interface StoredAlarm {
  timestamp: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface DurableObjectStorageTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  deleteAll(): Promise<void>;
}

interface DoStorageRow {
  key: string;
  value: string | null;
}

/**
 * DO storage 的 SQLite 实现。表结构由调用方保证存在：
 *   do_storage(do_name TEXT, key TEXT, value TEXT, PRIMARY KEY(do_name, key))
 * alarm 复用同一张表，存特殊 key `__alarm__`（值为毫秒时间戳的 JSON）。
 */
export class DurableObjectStorageShim {
  readonly #db: DatabaseSync;
  readonly #name: string;
  readonly #stmts = new Map<string, StatementSync>();
  #alarm: StoredAlarm | undefined;

  constructor(db: DatabaseSync, name: string) {
    this.#db = db;
    this.#name = name;
  }

  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    const owner = storageOwner.getStore();
    if (owner?.active && owner.db === this.#db) {
      if (owner.storage !== this) throw new Error('Cannot access another Durable Object storage inside a transaction');
      return fn();
    }
    const previous = storageLocks.get(this.#db) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    storageLocks.set(this.#db, current);
    await previous;
    const context = { db: this.#db, storage: this, active: true };
    try { return await storageOwner.run(context, fn); }
    finally {
      context.active = false;
      release();
      if (storageLocks.get(this.#db) === current) storageLocks.delete(this.#db);
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined>;
  async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T = unknown>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    return this.#locked(async () => {
    if (Array.isArray(key)) {
      const result = new Map<string, T>();
      for (const item of key) { const value = await this.get<T>(item); if (value !== undefined) result.set(item, value); }
      return result;
    }
    const row = this.#select.get(...([this.#name, key] as never[])) as DoStorageRow | undefined;
    if (!row || row.value === null) return undefined;
    return JSON.parse(row.value) as T;
    });
  }

  async put(key: string, value: unknown): Promise<void>;
  async put(entries: Record<string, unknown>): Promise<void>;
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    return this.#locked(async () => {
    if (typeof key !== 'string') { for (const [name, item] of Object.entries(key)) await this.put(name, item); return; }
    this.#upsert.run(...([this.#name, key, JSON.stringify(value)] as never[]));
    });
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(key: string | string[]): Promise<boolean | number> {
    return this.#locked(async () => {
    if (Array.isArray(key)) { let count = 0; for (const item of key) if (await this.delete(item)) count++; return count; }
    const info = this.#delete.run(...([this.#name, key] as never[]));
    return Number(info.changes) > 0;
    });
  }

  async list<T = unknown>(options: { prefix?: string; limit?: number; reverse?: boolean } = {}): Promise<Map<string, T>> {
    return this.#locked(async () => {
    const prefix = (options.prefix ?? '').replace(/[\\%_]/g, '\\$&') + '%';
    const limit = Math.max(1, Math.min(1000, options.limit ?? 1000));
    const rows = this.#statement(`SELECT key,value FROM do_storage WHERE do_name=? AND key LIKE ? ESCAPE '\\' ORDER BY key ${options.reverse ? 'DESC' : 'ASC'} LIMIT ?`).all(...([this.#name, prefix, limit] as never[])) as DoStorageRow[];
    return new Map(rows.filter(row => row.value !== null).map(row => [row.key, JSON.parse(row.value!) as T]));
    });
  }

  async deleteAll(): Promise<void> {
    return this.#locked(async () => { this.#deleteAllFor.run(...([this.#name] as never[])); });
  }

  /**
   * 事务：fn 里拿到的 storage 句柄在事务内读写可见；fn 抛错时整个
   * 事务回滚（official-resources.ts 靠这个保证 job 与 alarm 原子更新）。
   */
  async transaction<T>(fn: (storage: DurableObjectStorageTransaction) => Promise<T>): Promise<T> {
    return this.#locked(async () => {
    this.#db.exec('BEGIN');
    try {
      const value = await fn(this);
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* 事务已由 SQLITE 内部终结 */ }
      throw error;
    }
    });
  }

  async getAlarm(): Promise<number | null> {
    const stored = await this.get<number>(ALARM_KEY);
    return stored ?? null;
  }

  /**
   * setAlarm：记录时间戳并安排 timer 触发实例的 alarm()。同一时刻只
   * 允许一个 alarm（与 Workers 一致：后 set 的覆盖先 set 的）。timer
   * 挂在模块级注册表上，进程退出前统一清理，避免句柄泄漏。
   */
  async setAlarm(timestamp: number): Promise<void> {
    await this.put(ALARM_KEY, timestamp);
    this.#armTimer(timestamp);
  }

  /** 按时间戳安排 timer；过期的立即触发（恢复持久化 alarm 时用） */
  #armTimer(timestamp: number): void {
    if (this.#alarm) clearTimeout(this.#alarm.timer);
    this.#alarm = { timestamp, timer: setTimeout(() => { void this.#fireAlarm(timestamp); }, Math.max(0, timestamp - Date.now())) };
    registerAlarmTimer(this.#alarm.timer);
  }

  /**
   * 实例化时恢复持久化的 alarm。
   *
   * Workers 在重启后会按存储里的时间戳继续投递；shim 若只把时间戳留在
   * do_storage 而不重建 timer，重启后 getAlarm() 返回一个过去的非 null 值，
   * 业务侧的「getAlarm()==null 才补挂」判断会永远不成立 —— 净化、官方同步、
   * sitemap 重建三条链就此永久停摆。这里按存储时间戳重新挂上（已过期的立即触发）。
   */
  _restoreAlarm(): void {
    void this.get<number>(ALARM_KEY).then(timestamp => {
      if (typeof timestamp === 'number' && this.#alarmCallback) this.#armTimer(timestamp);
    });
  }

  async deleteAlarm(): Promise<void> {
    await this.delete(ALARM_KEY);
    if (this.#alarm) { clearTimeout(this.#alarm.timer); this.#alarm = undefined; }
  }

  /** 到点后核对 alarm 仍有效（期间可能被 deleteAlarm/覆盖）再触发 */
  async #fireAlarm(scheduledAt: number): Promise<void> {
    if (this.#alarm?.timestamp !== scheduledAt) return;
    this.#alarm = undefined;
    const callback = this.#alarmCallback;
    if (!callback) return;
    await this.delete(ALARM_KEY);
    try {
      await callback();
    } catch (error) {
      // Workers 对 alarm 异常会指数退避重试；shim 不能让它冒成 unhandledRejection
      // （Node 24 默认终止进程）。记录后按 30 秒重排，保留重试语义。
      console.error('DO alarm 执行失败:', error instanceof Error ? error.message : String(error));
      await this.setAlarm(Date.now() + 30_000).catch(() => {});
    }
  }

  /** 由所属 state 注入：触发时走与 fetch 相同的互斥队列 */
  #alarmCallback: (() => Promise<void>) | undefined;

  /** @internal 仅由 DurableObjectStateShim 调用 */
  _setAlarmCallback(callback: (() => Promise<void>) | undefined): void {
    this.#alarmCallback = callback;
  }

  #statement(sql: string): StatementSync {
    const cached = this.#stmts.get(sql);
    if (cached) return cached;
    const stmt = this.#db.prepare(sql);
    this.#stmts.set(sql, stmt);
    return stmt;
  }

  get #select(): StatementSync { return this.#statement('SELECT value FROM do_storage WHERE do_name = ? AND key = ?'); }
  get #upsert(): StatementSync { return this.#statement('INSERT INTO do_storage (do_name, key, value) VALUES (?, ?, ?) ON CONFLICT(do_name, key) DO UPDATE SET value = excluded.value'); }
  get #delete(): StatementSync { return this.#statement('DELETE FROM do_storage WHERE do_name = ? AND key = ?'); }
  get #deleteAllFor(): StatementSync { return this.#statement('DELETE FROM do_storage WHERE do_name = ?'); }
}

// ── 实例状态 ─────────────────────────────────────────────────────────────────

export class DurableObjectStateShim {
  readonly storage: DurableObjectStorageShim;
  readonly #waitUntilTasks: Promise<unknown>[] = [];
  /**
   * 互斥队列：input gate 的等价物。同一实例的 fetch/alarm/
   * blockConcurrencyWhile 依次排队，前一个 settle 完才放行下一个。
   */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(db: DatabaseSync, name: string) {
    this.storage = new DurableObjectStorageShim(db, name);
    this.storage._setAlarmCallback(() => this.#enqueue('alarm', async () => {
      // alarm() 方法由业务类提供；没有 alarm 方法的实例（不该 setAlarm）
      // 到点直接跳过
      const self = this.#instance as { alarm?: () => Promise<void> };
      if (typeof self.alarm === 'function') await self.alarm();
    }));
  }

  /** 实例由工厂注入，供 alarm 路由与互斥队列使用 */
  #instance: { fetch?: (request: Request) => Promise<Response>; alarm?: () => Promise<void> } & object = undefined as never;

  /** @internal 仅由 createDoNamespace 调用 */
  _attach(instance: object): void {
    this.#instance = instance as never;
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    if (activeObjects.getStore() === this) return fn();
    return this.#enqueue('block', fn);
  }

  /** @internal fetch 请求入队 */
  _runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.#enqueue('fetch', fn);
  }

  waitUntil(promise: Promise<unknown>): void {
    this.#waitUntilTasks.push(promise);
  }

  /** @internal 测试/收尾用：等所有 waitUntil 任务结束 */
  async _drainWaitUntil(): Promise<void> {
    await Promise.allSettled(this.#waitUntilTasks);
  }

  #enqueue<T>(_tag: string, fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(() => activeObjects.run(this, fn), () => activeObjects.run(this, fn));
    // 队列继续走：前一个失败不阻塞后续请求（错误只抛给当次调用方）
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

// 进程退出前清理所有未触发的 alarm timer，避免 Node 报句柄泄漏
const alarmTimers = new Set<ReturnType<typeof setTimeout>>();

function registerAlarmTimer(timer: ReturnType<typeof setTimeout>): void {
  alarmTimers.add(timer);
  timer.unref?.();
}

export function disposeAllDoAlarms(): void {
  for (const timer of alarmTimers) clearTimeout(timer);
  alarmTimers.clear();
}

// ── 命名空间 ─────────────────────────────────────────────────────────────────

export interface DurableObjectId {
  readonly name: string;
}

export interface DurableObjectStub {
  fetch(request: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export class DurableObjectNamespaceShim {
  readonly #db: DatabaseSync;
  readonly #ctor: new (state: DurableObjectStateShim, env: unknown) => object;
  readonly #env: unknown;
  // 按名单例：Workers 的 idFromName 语义（同名 → 同实例）
  readonly #instances = new Map<string, { state: DurableObjectStateShim; stub: DurableObjectStub }>();
  readonly #ids = new Map<string, DurableObjectId>();

  constructor(
    db: DatabaseSync,
    ctor: new (state: DurableObjectStateShim, env: unknown) => object,
    env: unknown,
  ) {
    this.#db = db;
    this.#ctor = ctor;
    this.#env = env;
  }

  idFromName(name: string): DurableObjectId {
    const cached = this.#ids.get(name);
    if (cached) return cached;
    const id = { name };
    this.#ids.set(name, id);
    return id;
  }

  /** Node shim 没有 64 位 hex id 的概念，直接把字符串当名字复用 */
  idFromString(id: string): DurableObjectId {
    return this.idFromName(id);
  }

  idToString(id: DurableObjectId): string {
    return id.name;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const existing = this.#instances.get(id.name);
    if (existing) return existing.stub;

    const state = new DurableObjectStateShim(this.#db, id.name);
    const instance = new this.#ctor(state, this.#env);
    state._attach(instance);
    // 恢复重启前持久化的 alarm（Workers 重启后同样会继续投递）
    state.storage._restoreAlarm();

    const stub: DurableObjectStub = {
      // Workers 的 stub.fetch 是 fetch 兼容签名（input 可为 Request|string|URL，
      // 且接受 init 第二参）——official-updates 传 ('https://…/start', { method: 'POST' })，
      // 丢弃 init 会让 DO 收到 GET 而 404
      fetch: (request: Request | string | URL, init?: RequestInit) => state._runExclusive(() => {
        const self = instance as { fetch: (request: Request) => Promise<Response> };
        const req = request instanceof Request ? request : new Request(request, init);
        return self.fetch(req);
      }),
    };
    const entry = { state, stub };
    this.#instances.set(id.name, entry);
    return stub;
  }

  /** @internal 测试用：等某实例排队的任务全部结束 */
  async _drain(name: string): Promise<void> {
    const entry = this.#instances.get(name);
    if (entry) await entry.state._drainWaitUntil();
  }
}

/**
 * 工厂：一个 binding 一个 namespace。ctor 接收 (state, env)，
 * 与业务类签名（DurableObjectState, Bindings）对齐。
 */
export function createDoNamespace(
  className: string,
  ctor: new (state: DurableObjectStateShim, env: unknown) => object,
  env: unknown,
  db: DatabaseSync,
): DurableObjectNamespaceShim {
  // className 参数当前不参与路由（表里不存类名），保留是为了让调用侧
  // 与 wrangler binding 名称对得上、便于排错
  void className;
  return new DurableObjectNamespaceShim(db, ctor, env);
}

/** 建表：shim 的调用方（Node 入口/测试）统一走这里 */
export function ensureDoStorageTable(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS do_storage (do_name TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (do_name, key))');
}
