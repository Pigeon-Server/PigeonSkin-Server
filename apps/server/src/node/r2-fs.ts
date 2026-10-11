// R2Bucket 的 Node 侧文件系统适配器：对象落盘为普通文件，
// 元数据（httpMetadata/customMetadata/uploaded/size/etag）存 node:sqlite。
//
// 业务代码对 BUCKET 的实际接口面（grep 全仓确认，只实现用到的子集）：
//   • get(key) → R2ObjectBody：body（ReadableStream）、arrayBuffer()、
//     json()、text()、size、httpEtag（textures/protocol/legacy-usm/
//     derivatives/live2d/tickets/do/derivatives）
//   • get(key, { range: { offset, length } }) → manual-assets.ts 的
//     手册音视频 206 分片下载（业务保证 offset/length 为合法非负整数）
//   • put(key, Uint8Array | ArrayBuffer | string, { httpMetadata,
//     customMetadata }) → textures/live2d/tickets/manual-assets/
//     official-catalog/official-updates/do/derivatives
//   • delete(key | key[]) → 单键与整页键数组（texture-access.ts/
//     live2d.ts/manual-assets.ts）
//   • head(key) → size（manual-assets.ts 的 Range 预检）
//   • list({ prefix, cursor, limit }) → objects[].key / truncated /
//     cursor（texture-access.ts/live2d.ts/site-management.ts）
// onlyIf 条件读写与分片上传业务未使用，不实现。
//
// key 含 '/' 按子目录落盘；resolve 后越出 root 的 key 抛 TypeError。
// R2Object/R2ObjectBody 用自有类对齐 workers-types 的形状（不能 extend
// 环境声明的 abstract class——它运行时并不存在）。

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync, type DatabaseSyncLike, type StatementSync } from './sqlite-shim.ts';

// workers-types 已作为全局类型注入（tsconfig types），这里的
// R2Object / R2ObjectBody / R2Range / R2HTTPMetadata / R2Checksums /
// R2Objects 均指其全局声明，无需 import。

export interface FileSystemR2Options {
  /** 对象文件的根目录（不存在时自动创建） */
  root: string;
  /** 元数据 SQLite 文件路径；默认 root 同级的 storage-meta.db */
  metaDbPath?: string;
  /** 复用已打开的 node:sqlite 连接（此时 close() 不会关闭它） */
  db?: DatabaseSyncLike;
}

/** Workers R2Bucket.put 接受的 value 形状（r2-s3.ts 复用同一转换） */
export type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

/** R2Bucket.get 第二参中业务用到的形状（range；onlyIf 未用不收） */
interface GetOptions {
  range?: R2Range;
}

/** R2Bucket.put 第二参中业务用到的形状 */
interface PutOptions {
  httpMetadata?: R2HTTPMetadata | Headers;
  customMetadata?: Record<string, string>;
}

interface MetaRow {
  key: string;
  etag: string;
  http_metadata: string | null;
  custom_metadata: string | null;
  uploaded: number;
  size: number;
}

interface ObjectInit {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata: R2HTTPMetadata | undefined;
  customMetadata: Record<string, string> | undefined;
  range: R2Range | undefined;
}

const encoder = new TextEncoder();

/** Uint8Array → 独立 ArrayBuffer（Blob/Response 需要可转移的完整缓冲） */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

export async function toBytes(value: PutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array(0);
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(toArrayBuffer(new Uint8Array(value)));
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (ArrayBuffer.isView(value)) {
    const out = new Uint8Array(value.byteLength);
    out.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return out;
  }
  // ReadableStream：Node 的 Response 能整段收流
  return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
}

/** Headers 形式的 httpMetadata（R2PutOptions 允许）展开成对象（r2-s3.ts 复用） */
export function normalizeHttpMetadata(input: R2HTTPMetadata | Headers | undefined): R2HTTPMetadata | undefined {
  if (input === undefined) return undefined;
  if (!(input instanceof Headers)) return input;
  const out: R2HTTPMetadata = {};
  const pick = (name: string): string | undefined => {
    const value = input.get(name);
    return value === null ? undefined : value;
  };
  const contentType = pick('content-type');
  if (contentType !== undefined) out.contentType = contentType;
  const contentLanguage = pick('content-language');
  if (contentLanguage !== undefined) out.contentLanguage = contentLanguage;
  const contentDisposition = pick('content-disposition');
  if (contentDisposition !== undefined) out.contentDisposition = contentDisposition;
  const contentEncoding = pick('content-encoding');
  if (contentEncoding !== undefined) out.contentEncoding = contentEncoding;
  const cacheControl = pick('cache-control');
  if (cacheControl !== undefined) out.cacheControl = cacheControl;
  return out;
}

function parseHttpMetadata(raw: string | null): R2HTTPMetadata | undefined {
  return raw === null ? undefined : JSON.parse(raw) as R2HTTPMetadata;
}

function parseCustomMetadata(raw: string | null): Record<string, string> | undefined {
  return raw === null ? undefined : JSON.parse(raw) as Record<string, string>;
}

/** 对齐 workers-types R2Object 的形状（无 body） */
export class R2StoredObject {
  readonly key: string;
  readonly version = '';
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly checksums = {} as R2Checksums;
  readonly uploaded: Date;
  readonly storageClass = 'STANDARD';
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly range?: R2Range;

  constructor(init: ObjectInit) {
    this.key = init.key;
    this.size = init.size;
    this.etag = init.etag;
    this.httpEtag = `"${init.etag}"`;
    this.uploaded = init.uploaded;
    if (init.httpMetadata !== undefined) this.httpMetadata = init.httpMetadata;
    if (init.customMetadata !== undefined) this.customMetadata = init.customMetadata;
    if (init.range !== undefined) this.range = init.range;
  }

  /** R2 语义：把 httpMetadata 写进响应头（manual-assets.ts 用） */
  writeHttpMetadata(headers: Headers): void {
    const meta = this.httpMetadata;
    if (meta === undefined) return;
    if (meta.contentType !== undefined) headers.set('content-type', meta.contentType);
    if (meta.contentLanguage !== undefined) headers.set('content-language', meta.contentLanguage);
    if (meta.contentDisposition !== undefined) headers.set('content-disposition', meta.contentDisposition);
    if (meta.contentEncoding !== undefined) headers.set('content-encoding', meta.contentEncoding);
    if (meta.cacheControl !== undefined) headers.set('cache-control', meta.cacheControl);
    if (meta.cacheExpiry !== undefined) headers.set('cache-expiry', meta.cacheExpiry.toUTCString());
  }
}

/** 对齐 workers-types R2ObjectBody：R2Object + body 与便捷读取方法 */
export class R2StoredObjectBody extends R2StoredObject {
  readonly #bytes: Uint8Array;
  #used = false;

  constructor(init: ObjectInit, bytes: Uint8Array) {
    super(init);
    this.#bytes = bytes;
  }

  get body(): ReadableStream {
    this.#used = true;
    return new Blob([toArrayBuffer(this.#bytes)]).stream();
  }

  get bodyUsed(): boolean {
    return this.#used;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.#used = true;
    return toArrayBuffer(this.#bytes);
  }

  async bytes(): Promise<Uint8Array> {
    this.#used = true;
    return this.#bytes.slice();
  }

  async text(): Promise<string> {
    this.#used = true;
    return new TextDecoder().decode(this.#bytes);
  }

  async json<T>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async blob(): Promise<Blob> {
    this.#used = true;
    return new Blob([toArrayBuffer(this.#bytes)]);
  }
}

export class FileSystemR2Bucket {
  readonly #root: string;
  readonly #db: DatabaseSyncLike;
  readonly #ownsDb: boolean;
  readonly #stmts = new Map<string, StatementSync>();

  constructor(options: FileSystemR2Options) {
    this.#root = resolve(options.root);
    mkdirSync(this.#root, { recursive: true });
    this.#ownsDb = options.db === undefined;
    this.#db = options.db ?? new DatabaseSync(options.metaDbPath ?? join(dirname(this.#root), 'storage-meta.db'));
    if (this.#ownsDb) {
      this.#db.exec('PRAGMA journal_mode = WAL');
      this.#db.exec('PRAGMA busy_timeout = 5000');
    }
    this.#db.exec(`CREATE TABLE IF NOT EXISTS storage_meta (
      key TEXT PRIMARY KEY,
      http_metadata TEXT,
      custom_metadata TEXT,
      uploaded INTEGER NOT NULL,
      size INTEGER NOT NULL,
      etag TEXT NOT NULL
    )`);
  }

  async get(key: string, options?: GetOptions): Promise<R2StoredObjectBody | null> {
    this.#checkKey(key);
    const row = this.#selectMeta(key);
    if (row === null) return null;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(this.#resolveKey(key)));
    } catch {
      // 元数据在而文件丢失 → 视为不存在（与 R2 一致语义）
      return null;
    }
    const size = bytes.length;
    let slice = bytes;
    let range: R2Range | undefined;
    const requested = options?.range;
    // R2Range 还有 { suffix } 变体，业务未使用（manual-assets 只发 offset/length）
    if (requested !== undefined && !('suffix' in requested)) {
      const offset = Math.max(0, requested.offset ?? 0);
      const length = Math.min(requested.length ?? size - offset, size - offset);
      slice = length > 0 ? bytes.subarray(offset, offset + length) : new Uint8Array(0);
      range = { offset, length };
    }
    return new R2StoredObjectBody({
      key,
      size,
      etag: row.etag,
      uploaded: new Date(Number(row.uploaded)),
      httpMetadata: parseHttpMetadata(row.http_metadata),
      customMetadata: parseCustomMetadata(row.custom_metadata),
      range,
    }, slice);
  }

  async head(key: string): Promise<R2StoredObject | null> {
    this.#checkKey(key);
    const row = this.#selectMeta(key);
    if (row === null) return null;
    try {
      await stat(this.#resolveKey(key));
    } catch {
      return null;
    }
    return new R2StoredObject({
      key,
      size: Number(row.size),
      etag: row.etag,
      uploaded: new Date(Number(row.uploaded)),
      httpMetadata: parseHttpMetadata(row.http_metadata),
      customMetadata: parseCustomMetadata(row.custom_metadata),
      range: undefined,
    });
  }

  async put(key: string, value: PutValue, options?: PutOptions): Promise<R2StoredObject> {
    const bytes = await toBytes(value);
    const path = this.#resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const etag = createHash('md5').update(bytes).digest('hex');
    const uploaded = Date.now();
    const httpMetadata = normalizeHttpMetadata(options?.httpMetadata);
    const customMetadata = options?.customMetadata;
    this.#stmt(`INSERT OR REPLACE INTO storage_meta (key, http_metadata, custom_metadata, uploaded, size, etag) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(...([
        key,
        httpMetadata === undefined ? null : JSON.stringify(httpMetadata),
        customMetadata === undefined ? null : JSON.stringify(customMetadata),
        uploaded,
        bytes.length,
        etag,
      ] as never[]));
    return new R2StoredObject({
      key,
      size: bytes.length,
      etag,
      uploaded: new Date(uploaded),
      httpMetadata,
      customMetadata,
      range: undefined,
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.#checkKey(key);
      this.#stmt('DELETE FROM storage_meta WHERE key = ?').run(...([key] as never[]));
      await unlink(this.#resolveKey(key)).catch(() => undefined);
    }
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects> {
    // R2 语义：未指定 limit 时默认 1000，上限 1000；cursor = 上一页最后
    // 一个 key（对业务代码不透明，循环续页即可）
    const limit = Math.max(1, Math.min(options?.limit ?? 1000, 1000));
    const prefix = options?.prefix;
    const cursor = options?.cursor;
    const rows = this.#stmt(`SELECT key, etag, http_metadata, custom_metadata, uploaded, size FROM storage_meta
      WHERE (?1 IS NULL OR key LIKE ?1 || '%' ESCAPE '\\') AND (?2 IS NULL OR key > ?2)
      ORDER BY key LIMIT ?3`)
      .all(...([
        prefix === undefined ? null : escapeLike(prefix),
        cursor ?? null,
        limit + 1,
      ] as never[])) as MetaRow[];
    const truncated = rows.length > limit;
    const page = truncated ? rows.slice(0, limit) : rows;
    const objects = page.map(row => this.#storedObject(row));
    const delimitedPrefixes: string[] = [];
    if (!truncated) return { objects, delimitedPrefixes, truncated: false };
    const last = page[page.length - 1];
    return { objects, delimitedPrefixes, truncated: true, cursor: last === undefined ? '' : last.key };
  }

  /** 关闭自有连接；外部传入的 db 由调用方负责生命周期 */
  close(): void {
    if (this.#ownsDb) this.#db.close();
  }

  #storedObject(row: MetaRow): R2StoredObject {
    return new R2StoredObject({
      key: row.key,
      size: Number(row.size),
      etag: row.etag,
      uploaded: new Date(Number(row.uploaded)),
      httpMetadata: parseHttpMetadata(row.http_metadata),
      customMetadata: parseCustomMetadata(row.custom_metadata),
      range: undefined,
    });
  }

  #selectMeta(key: string): MetaRow | null {
    const row = this.#stmt('SELECT key, etag, http_metadata, custom_metadata, uploaded, size FROM storage_meta WHERE key = ?')
      .get(...([key] as never[])) as MetaRow | undefined;
    return row ?? null;
  }

  // key 含 '/' 按子目录落盘；resolve 后必须仍在 root 内（防路径穿越）
  #checkKey(key: string): void {
    if (key.length === 0 || key.startsWith('/') || key.includes('\\') || key.includes('\0')) {
      throw new TypeError(`非法 R2 key：${JSON.stringify(key)}`);
    }
    const resolved = resolve(this.#root, key);
    const rootPrefix = this.#root.endsWith(sep) ? this.#root : this.#root + sep;
    if (!resolved.startsWith(rootPrefix)) {
      throw new TypeError(`R2 key 越出存储根目录：${JSON.stringify(key)}`);
    }
  }

  #resolveKey(key: string): string {
    this.#checkKey(key);
    return resolve(this.#root, key);
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

/** LIKE 前缀匹配的通配符转义（配 ESCAPE '\'） */
function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
