// r2-s3（S3 兼容存储驱动）测试：不需要真实 S3——mock 全局 fetch 捕获
// aws4fetch 签名后的请求，验证 SigV4 头存在、方法/URL/Range/Content-Type
// 正确、404 → null、ListObjectsV2 参数与响应解析。
// aws4fetch 的签名计算依赖 crypto.subtle（Node 22+ 全局可用）与 Date，测试
// 用 fake timers 固定签名时间不影响（datetime 从真实时钟生成，无需固定）。

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { S3R2Bucket } from '../../src/node/r2-s3.ts';

interface CapturedRequest {
  method: string;
  url: string;
  headers: Headers;
  bodyText: string | undefined;
}

let captured: CapturedRequest;
let respond: () => Response;

function xmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml', ...headers } });
}

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <Prefix>avatars/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>2</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>next-token-1</NextContinuationToken>
  <Contents>
    <Key>avatars/a.png</Key>
    <LastModified>2026-01-01T00:00:00.000Z</LastModified>
    <ETag>&quot;etag-a&quot;</ETag>
    <Size>10</Size>
  </Contents>
  <Contents>
    <Key>avatars/b.png</Key>
    <LastModified>2026-01-02T00:00:00.000Z</LastModified>
    <ETag>&quot;etag-b&quot;</ETag>
    <Size>20</Size>
  </Contents>
</ListBucketResult>`;

beforeEach(() => {
  captured = { method: '', url: '', headers: new Headers(), bodyText: undefined };
  respond = () => new Response('', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (_input: Request | string, init?: RequestInit) => {
    const request = _input instanceof Request ? _input : new Request(_input, init);
    captured.method = request.method;
    captured.url = request.url;
    captured.headers = request.headers;
    captured.bodyText = request.method === 'PUT' || request.method === 'GET'
      ? undefined
      : undefined;
    if (request.method === 'PUT') {
      const buffer = await request.clone().arrayBuffer().catch(() => new ArrayBuffer(0));
      captured.bodyText = new TextDecoder().decode(buffer);
    }
    return respond();
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeBucket(): S3R2Bucket {
  return new S3R2Bucket({
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'my-bucket',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
  });
}

describe('签名与方法/URL', () => {
  it('get：SigV4 Authorization 头存在，URL 为路径风格 /bucket/key', async () => {
    respond = () => new Response('hello', {
      status: 200,
      headers: { 'Content-Length': '5', ETag: '"abc123"', 'Last-Modified': 'Thu, 01 Jan 2026 00:00:00 GMT' },
    });
    const bucket = makeBucket();
    const object = await bucket.get('textures/abc.png');

    expect(captured.method).toBe('GET');
    expect(captured.url).toBe('https://s3.example.com/my-bucket/textures/abc.png');
    const auth = captured.headers.get('authorization');
    expect(auth).not.toBeNull();
    expect(auth).toContain('AWS4-HMAC-SHA256');
    expect(auth).toContain('Credential=AKIDEXAMPLE');
    expect(captured.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(captured.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');

    expect(object).not.toBeNull();
    expect(object!.key).toBe('textures/abc.png');
    expect(object!.size).toBe(5);
    expect(object!.etag).toBe('abc123');
    expect(object!.httpEtag).toBe('"abc123"');
    expect(await object!.text()).toBe('hello');
  });

  it('get(key, { range: { offset, length } })：Range 头 + 206 解析 Content-Range', async () => {
    respond = () => new Response('2345', {
      status: 206,
      headers: {
        'Content-Range': 'bytes 2-5/10',
        'Content-Length': '4',
        ETag: '"abc123"',
        'Last-Modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
      },
    });
    const bucket = makeBucket();
    const object = await bucket.get('media/video.mp4', { range: { offset: 2, length: 4 } });

    expect(captured.headers.get('range')).toBe('bytes=2-5');
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe('2345');
    expect(object!.range).toEqual({ offset: 2, length: 4 });
    expect(object!.size).toBe(10);
  });

  it('get 404 → null', async () => {
    respond = () => new Response('NoSuchKey', { status: 404 });
    const bucket = makeBucket();
    expect(await bucket.get('missing.png')).toBeNull();
  });

  it('get 非 404 错误抛错', async () => {
    respond = () => new Response('boom', { status: 500 });
    const bucket = makeBucket();
    await expect(bucket.get('k')).rejects.toThrow('HTTP 500');
  });

  it('put：PUT 方法、Content-Type/Cache-Control/x-amz-meta 映射、body 原样', async () => {
    respond = () => new Response('', {
      status: 200,
      headers: { ETag: '"deadbeef"', 'Last-Modified': 'Thu, 01 Jan 2026 00:00:00 GMT' },
    });
    const bucket = makeBucket();
    const stored = await bucket.put('skins/a.png', new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { Origin: 'test' },
    });

    expect(captured.method).toBe('PUT');
    expect(captured.url).toBe('https://s3.example.com/my-bucket/skins/a.png');
    expect(captured.headers.get('content-type')).toBe('image/png');
    expect(captured.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(captured.headers.get('x-amz-meta-origin')).toBe('test');
    expect(captured.bodyText).toBe(new TextDecoder().decode(new Uint8Array([1, 2, 3])));
    expect(captured.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    expect(stored.size).toBe(3);
    expect(stored.etag).toBe('deadbeef');
    expect(stored.httpMetadata?.contentType).toBe('image/png');
    expect(stored.customMetadata).toEqual({ Origin: 'test' });
  });

  it('head：HEAD 方法，返回 size/etag，404 → null', async () => {
    const bucket = makeBucket();
    respond = () => new Response('', {
      status: 200,
      headers: { 'Content-Length': '42', ETag: '"head-etag"', 'Last-Modified': 'Thu, 01 Jan 2026 00:00:00 GMT', 'Content-Type': 'image/png' },
    });
    const object = await bucket.head('a.png');
    expect(captured.method).toBe('HEAD');
    expect(object).not.toBeNull();
    expect(object!.size).toBe(42);
    expect(object!.etag).toBe('head-etag');
    expect(object!.httpMetadata?.contentType).toBe('image/png');
    expect('body' in object!).toBe(false);

    respond = () => new Response('', { status: 404 });
    expect(await bucket.head('missing.png')).toBeNull();
  });

  it('delete：DELETE 方法、数组逐个发、404 视为幂等成功', async () => {
    respond = () => new Response(null, { status: 204 });
    const bucket = makeBucket();
    await bucket.delete('a.png');
    expect(captured.method).toBe('DELETE');
    expect(captured.url).toBe('https://s3.example.com/my-bucket/a.png');

    // 数组：两个键两个请求，第二个 404 不报错（spy 累计含上面单键那次）
    vi.mocked(fetch).mockClear();
    const statuses = [204, 404];
    let call = 0;
    vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: statuses[call++] ?? 204 }));
    await bucket.delete(['b.png', 'missing.png']);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('list：list-type=2 + prefix/max-keys/continuation-token，解析 Contents 与分页', async () => {
    respond = () => xmlResponse(LIST_XML);
    const bucket = makeBucket();

    const page = await bucket.list({ prefix: 'avatars/', limit: 2, cursor: 'prev-token' });
    expect(captured.method).toBe('GET');
    const url = new URL(captured.url);
    expect(url.pathname).toBe('/my-bucket/');
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.searchParams.get('prefix')).toBe('avatars/');
    expect(url.searchParams.get('max-keys')).toBe('2');
    expect(url.searchParams.get('continuation-token')).toBe('prev-token');

    expect(page.truncated).toBe(true);
    if (!page.truncated) throw new Error('unreachable');
    expect(page.cursor).toBe('next-token-1');
    expect(page.objects.map(object => object.key)).toEqual(['avatars/a.png', 'avatars/b.png']);
    expect(page.objects[0]!.size).toBe(10);
    expect(page.objects[0]!.uploaded).toBeInstanceOf(Date);

    // 最后一页：IsTruncated=false → 无 cursor
    respond = () => xmlResponse(LIST_XML.replace('<IsTruncated>true</IsTruncated>', '<IsTruncated>false</IsTruncated>').replace(/<NextContinuationToken>.*?<\/NextContinuationToken>/, ''));
    const last = await bucket.list({ prefix: 'avatars/', limit: 2 });
    expect(last.truncated).toBe(false);
    expect('cursor' in last).toBe(false);
  });

  it('list 默认 limit 1000、无 prefix 时省略 prefix 参数', async () => {
    respond = () => xmlResponse(LIST_XML.replace('<IsTruncated>true</IsTruncated>', '<IsTruncated>false</IsTruncated>').replace(/<NextContinuationToken>.*?<\/NextContinuationToken>/, ''));
    const bucket = makeBucket();
    await bucket.list();
    const url = new URL(captured.url);
    expect(url.searchParams.get('max-keys')).toBe('1000');
    expect(url.searchParams.has('prefix')).toBe(false);
    expect(url.searchParams.has('continuation-token')).toBe(false);
  });

  it('endpoint 含 bucket 时不再拼接 S3_BUCKET', async () => {
    respond = () => new Response('x', { status: 200, headers: { 'Content-Length': '1', ETag: '"e"' } });
    const bucket = new S3R2Bucket({
      endpoint: 'https://account.r2.cloudflarestorage.com/my-bucket',
      region: 'auto',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
    });
    await bucket.get('k.png');
    expect(captured.url).toBe('https://account.r2.cloudflarestorage.com/my-bucket/k.png');
  });

  it('key 逐段编码：空格与中文编码，/ 分隔符保留', async () => {
    respond = () => new Response(null, { status: 204 });
    const bucket = makeBucket();
    await bucket.delete('dir/a b/中文.png');
    expect(captured.url).toBe(`https://s3.example.com/my-bucket/dir/a%20b/${encodeURIComponent('中文')}.png`);
  });
});
