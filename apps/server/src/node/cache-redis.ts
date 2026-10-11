// Cache API（caches.default）的 Redis 驱动：接口与 cache-shim.ts 的
// CacheShim 相同（match/put/delete，键为 URL 字符串或 Request）。
//
// 存储布局：SET pigeon:cache:<url> <serialized> EX ttl。serialized 是
// JSON：{ status, headers, body }，body 为 base64（键值都是文本，二进制
// 直接塞 JSON 会丢；skin 缩略图等二进制缓存走这里，base64 膨胀 1/3 可接受）。
//
// TTL 语义：从响应的 Cache-Control: max-age 解析过期秒数写入 EX，让 Redis
// 自动淘汰；没有 max-age 的条目（如 sitemap 版本键）不设 TTL，与 cache-shim
// 的"不淘汰"行为一致，靠 put 覆盖与 delete 主动清理。
//
// 与 installCacheShim 的关系：runtime.ts 装配时二选一——REDIS_URL 未配置用
// SQLite 版 installCacheShim，配置后用本文件的 installRedisCacheShim 把
// 同形状对象装到 globalThis.caches。业务代码只裸引用 caches.default，无感。

import { getRedis } from './redis.ts';
import type { CacheStorageShim } from './cache-shim.ts';
import { installCacheStorage } from './cache-shim.ts';

export const CACHE_KEY_PREFIX = 'pigeon:cache:';

/** Cache API 的 request 形状：Request 实例或字符串 URL 键（与 cache-shim 一致） */
type CacheKeyInput = Request | string;

function toKey(request: CacheKeyInput): string {
  return typeof request === 'string' ? request : request.url;
}

interface SerializedEntry {
  status: number;
  headers: [string, string][];
  body: string; // base64
}

/** 从 Cache-Control 提取 max-age 秒数；无指令或非法值返回 undefined */
function parseMaxAge(headers: Headers): number | undefined {
  const cacheControl = headers.get('cache-control');
  if (cacheControl === null) return undefined;
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i.exec(cacheControl);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export class RedisCacheShim {
  async match(request: CacheKeyInput): Promise<Response | undefined> {
    // 缓存是增益路径：Redis 断连/命令失败一律按未命中处理，
    // 与限流驱动的 fail-open 策略一致，不让热路径 500
    try {
      return await this.#matchInner(request);
    } catch (error) {
      console.error('[cache-redis] match 失败，按未命中处理', error);
      return undefined;
    }
  }

  async #matchInner(request: CacheKeyInput): Promise<Response | undefined> {
    const redis = await getRedis();
    if (redis === undefined) return undefined;
    const raw = await redis.get(CACHE_KEY_PREFIX + toKey(request));
    if (raw === null) return undefined;
    let entry: SerializedEntry;
    try {
      entry = JSON.parse(raw) as SerializedEntry;
    } catch {
      return undefined; // 条目损坏按未命中处理，不炸业务请求
    }
    return new Response(base64ToArrayBuffer(entry.body), { status: entry.status, headers: entry.headers });
  }

  async put(request: CacheKeyInput, response: Response): Promise<void> {
    // put 失败只损失缓存，不影响源站响应
    try {
      await this.#putInner(request, response);
    } catch (error) {
      console.error('[cache-redis] put 失败，忽略', error);
    }
  }

  async #putInner(request: CacheKeyInput, response: Response): Promise<void> {
    const redis = await getRedis();
    if (redis === undefined) return;
    const body = await response.arrayBuffer();
    const entry: SerializedEntry = {
      status: response.status,
      headers: [...response.headers.entries()],
      body: arrayBufferToBase64(body),
    };
    const serialized = JSON.stringify(entry);
    const ttl = parseMaxAge(response.headers);
    const key = CACHE_KEY_PREFIX + toKey(request);
    // set(..., 'EX', seconds) 与不帯 EX 的重载二选一；TTL 语义见文件头
    if (ttl === undefined) await redis.set(key, serialized);
    else await redis.set(key, serialized, 'EX', ttl);
  }

  async delete(request: CacheKeyInput): Promise<boolean> {
    const redis = await getRedis();
    if (redis === undefined) return false;
    return (await redis.del(CACHE_KEY_PREFIX + toKey(request))) > 0;
  }

  /** 清空全部缓存条目（测试与运维用；scan 而非 KEYS，避免阻塞 Redis） */
  async clear(): Promise<void> {
    const redis = await getRedis();
    if (redis === undefined) return;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', CACHE_KEY_PREFIX + '*', 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

/**
 * 构造 Redis 缓存 shim；未配置 REDIS_URL 返回 undefined（runtime 回退
 * SQLite 版）。装配到 globalThis.caches 用 installRedisCacheShim。
 */
export async function createRedisCacheShim(): Promise<RedisCacheShim | undefined> {
  const { isRedisEnabled } = await import('./redis.ts');
  return isRedisEnabled() ? new RedisCacheShim() : undefined;
}

/** 与 cache-shim.ts 的 installCacheShim 对应：把 Redis shim 装上 globalThis.caches */
export function installRedisCacheShim(shim: RedisCacheShim): void {
  installCacheStorage({ default: shim } as CacheStorageShim);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const view = Buffer.from(base64, 'base64');
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
