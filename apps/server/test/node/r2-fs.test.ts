// r2-fs（文件系统 R2 适配器）与 cache-shim（Cache API 模拟）的 Node 冒烟测试。
//
// 覆盖：put→get 往返（httpMetadata/size）、range 读、get 未命中、
// head/list(prefix,limit)、delete 单个与数组、路径穿越拒绝；
// 缓存 shim 的 put→match→delete→match、字符串键与 Request 键等价、
// installCacheShim 对 globalThis.caches 的装配。

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemR2Bucket } from '../../src/node/r2-fs.ts';
import { CacheShim, installCacheShim } from '../../src/node/cache-shim.ts';

let dir: string;
let bucket: FileSystemR2Bucket;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pigeon-r2-'));
  bucket = new FileSystemR2Bucket({ root: join(dir, 'objects') });
});

afterEach(async () => {
  bucket.close();
  await rm(dir, { recursive: true, force: true });
});

describe('FileSystemR2Bucket', () => {
  it('put → get 往返：字节、httpMetadata、size、httpEtag、uploaded', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await bucket.put('textures/abc.png', bytes, {
      httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
    });
    const object = await bucket.get('textures/abc.png');
    expect(object).not.toBeNull();
    expect(object!.key).toBe('textures/abc.png');
    expect(object!.size).toBe(5);
    expect(object!.httpMetadata?.contentType).toBe('image/png');
    expect(object!.httpMetadata?.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(object!.httpEtag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(object!.uploaded).toBeInstanceOf(Date);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);

    // writeHttpMetadata 把 httpMetadata 写进 Headers
    const headers = new Headers();
    object!.writeHttpMetadata(headers);
    expect(headers.get('content-type')).toBe('image/png');
    expect(headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('put 接受 string / ArrayBuffer，get 便捷方法 text()/json()/bytes() 可用', async () => {
    await bucket.put('notes/hello.txt', '你好');
    const text = await bucket.get('notes/hello.txt');
    expect(await text!.text()).toBe('你好');

    const payload = JSON.stringify({ model: 'aoba' });
    await bucket.put('live2d/manifest.json', new TextEncoder().encode(payload).buffer as ArrayBuffer);
    const json = await bucket.get('live2d/manifest.json');
    expect(await json!.json<{ model: string }>()).toEqual({ model: 'aoba' });
    expect((await json!.bytes()).length).toBe(payload.length);
    expect(json!.body).toBeInstanceOf(ReadableStream);
  });

  it('get(key, { range: { offset, length } })：分片读取 + range 回显', async () => {
    await bucket.put('media/video.mp4', '0123456789');
    const object = await bucket.get('media/video.mp4', { range: { offset: 2, length: 4 } });
    expect(await object!.text()).toBe('2345');
    expect(object!.size).toBe(10);
    expect(object!.range).toEqual({ offset: 2, length: 4 });
  });

  it('get 未命中返回 null；删除后同样返回 null', async () => {
    expect(await bucket.get('missing/key.png')).toBeNull();
    await bucket.put('gone.png', 'x');
    await bucket.delete('gone.png');
    expect(await bucket.get('gone.png')).toBeNull();
  });

  it('head 返回元数据（无 body），未命中返回 null', async () => {
    await bucket.put('a/b.png', 'hello', { customMetadata: { origin: 'test' } });
    const head = await bucket.head('a/b.png');
    expect(head).not.toBeNull();
    expect(head!.size).toBe(5);
    expect(head!.customMetadata).toEqual({ origin: 'test' });
    expect('body' in head!).toBe(false);
    expect(await bucket.head('a/missing.png')).toBeNull();
  });

  it('list：prefix 过滤、limit 分页（truncated + cursor 续页）', async () => {
    for (const key of ['avatars/v3/h1/a', 'avatars/v3/h1/b', 'avatars/v3/h1/c', 'previews/v3/h1.png']) {
      await bucket.put(key, 'x');
    }
    // site-management.ts 的存活探测形态：list({ limit: 1 })
    const probe = await bucket.list({ limit: 1 });
    expect(probe.objects).toHaveLength(1);
    expect(probe.truncated).toBe(true);
    if (!probe.truncated) throw new Error('unreachable');

    // texture-access.ts / live2d.ts 的续页循环形态
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: 'avatars/v3/h1/', ...(cursor ? { cursor } : {}), limit: 2 });
      keys.push(...page.objects.map(object => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    expect(keys).toEqual(['avatars/v3/h1/a', 'avatars/v3/h1/b', 'avatars/v3/h1/c']);

    // 无 prefix 的全量 list 在 limit 内不截断
    const all = await bucket.list();
    expect(all.objects).toHaveLength(4);
    expect(all.truncated).toBe(false);
    if (all.truncated) throw new Error('unreachable');
  });

  it('delete 单键与键数组；数组里不存在的键不报错', async () => {
    await bucket.put('a', '1');
    await bucket.put('b', '2');
    await bucket.put('c', '3');
    await bucket.delete('a');
    expect(await bucket.head('a')).toBeNull();
    await bucket.delete(['b', 'missing', 'c']);
    expect(await bucket.head('b')).toBeNull();
    expect(await bucket.head('c')).toBeNull();
  });

  it('路径穿越拒绝：../ 与绝对路径抛 TypeError，未写入任何对象', async () => {
    await expect(bucket.put('../escape.png', 'x')).rejects.toThrow(TypeError);
    await expect(bucket.get('../escape.png')).rejects.toThrow(TypeError);
    await expect(bucket.put('/abs.png', 'x')).rejects.toThrow(TypeError);
    await expect(bucket.get('/abs.png')).rejects.toThrow(TypeError);
    expect(await bucket.list()).toMatchObject({ truncated: false, objects: [] });
  });

  it('同 key 重复 put：内容与 size 覆盖更新', async () => {
    await bucket.put('k', 'aaaaa');
    await bucket.put('k', 'bb');
    const object = await bucket.get('k');
    expect(await object!.text()).toBe('bb');
    expect(object!.size).toBe(2);
  });
});

describe('CacheShim / installCacheShim', () => {
  it('put(Request) → match(Request)：status/headers/body 重建', async () => {
    const shim = new CacheShim({ path: ':memory:' });
    const request = new Request('https://texture-cache.invalid/textures/abc');
    await shim.put(request, new Response('png-bytes', {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' },
    }));
    const hit = await shim.match(new Request('https://texture-cache.invalid/textures/abc'));
    expect(hit).toBeInstanceOf(Response);
    expect(hit!.status).toBe(200);
    expect(hit!.headers.get('content-type')).toBe('image/png');
    expect(await hit!.text()).toBe('png-bytes');
    shim.close();
  });

  it('字符串键与 Request 键等价；delete → true，再 match → undefined', async () => {
    const shim = new CacheShim({ path: ':memory:' });
    // sitemap-cache.ts：字符串键 'https://sitemap.internal/__version__'
    const stringKey = 'https://sitemap.internal/__version__';
    await shim.put(stringKey, new Response('2'));
    expect(await (await shim.match(stringKey))!.text()).toBe('2');
    // 同一 URL 以 Request 形式也能命中
    expect(await (await shim.match(new Request(stringKey)))!.text()).toBe('2');

    // texture-access.ts：delete(new Request(url)) → boolean
    expect(await shim.delete(new Request(stringKey))).toBe(true);
    expect(await shim.match(stringKey)).toBeUndefined();
    expect(await shim.delete(stringKey)).toBe(false);
    shim.close();
  });

  it('installCacheShim：globalThis.caches.default 裸引用可用（业务代码形态）', async () => {
    const shim = installCacheShim({ path: ':memory:' });
    // yggdrasil.ts：put 字符串 cacheKey + new Response(...)，match 后 json()
    const cacheKey = 'https://ygg-cache.internal/mojang/uuid';
    await caches.default.put(cacheKey, new Response(JSON.stringify({ name: 'Notch' }), {
      headers: { 'Cache-Control': 'public, max-age=300' },
    }));
    const hit = await caches.default.match(new Request(cacheKey));
    expect(await hit!.json<{ name: string }>()).toEqual({ name: 'Notch' });
    expect(hit!.headers.get('cache-control')).toBe('public, max-age=300');
    // 返回的 shim 与全局是同一实例
    expect(await shim.delete(cacheKey)).toBe(true);
    expect(await caches.default.match(cacheKey)).toBeUndefined();
  });
});
