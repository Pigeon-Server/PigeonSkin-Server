// R2Bucket 的 S3 兼容存储驱动：用 aws4fetch（SigV4）对接任意 S3 兼容
// 后端（MinIO/Cloudflare R2 S3 端点/阿里云 OSS S3 兼容层等），方法面
// 对照 r2-fs.ts 的 FileSystemR2Bucket（get(+range)/put/delete/head/list），
// 复用其 R2StoredObject/R2StoredObjectBody 类返回同形状对象，业务代码无感。
//
// 请求布局：GET/PUT/DELETE/HEAD /{endpoint 上的 bucket 路径}/{key}。
// endpoint 已含 bucket（如 https://s3.example.com/my-bucket）时直接拼 key；
// 否则视为服务级 endpoint（https://s3.example.com），拼 /{bucket}/{key}——
// 路径风格而非虚拟主机风格，兼容自建网关与 R2 的 <account>.r2.cloudflarestorage.com。
//
// 元数据映射（S3 与 R2 的对应关系）：
//   Content-Type / Cache-Control 头 ↔ httpMetadata.contentType/cacheControl
//   x-amz-meta-* 头 ↔ customMetadata
//   ETag ↔ etag（httpEtag 由 R2StoredObject 加引号生成）
//   Content-Length ↔ size
//   x-amz-meta-... 非 ASCII 值：S3 规范要求 HTTP 头 ASCII，实际后端普遍
//   存 UTF-8 原文，这里按 UTF-8 读回（put 端不做额外编码，与 r2-fs 行为对齐）。
//
// Range 语义：get(key, { range }) 把 R2Range 翻译成 Range 头（suffix 变体
// → bytes=-N），响应 206 时按 S3 的 Content-Range 回填 range 字段。业务侧
// （manual-assets.ts）只发 offset/length 且保证合法，这里仍做防御性 clamp。
//
// list：GET /?list-type=2（ListObjectsV2），continuation-token 对齐 R2 的
// cursor（对业务代码不透明，循环续页即可）；未指定 limit 默认 1000（S3
// 单页上限同为 1000），max-keys+1 的取法在 S3 分页下不成立——直接用返回
// 的 IsTruncated/NextContinuationToken 判断截断。
//
// 错误语义：404/405（部分后端用 405 表示方法不支持于该对象）→ null。

import { AwsClient } from 'aws4fetch';
import { normalizeHttpMetadata, R2StoredObject, R2StoredObjectBody, toBytes, type PutValue } from './r2-fs.ts';

export interface S3StorageOptions {
  /** S3 端点，如 https://s3.example.com 或含 bucket 的 https://s3.example.com/my-bucket */
  endpoint: string;
  /** SigV4 region（R2 S3 端点用 auto，MinIO 任意值如 us-east-1） */
  region: string;
  /** endpoint 不含 bucket 时必填 */
  bucket?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
}

/** R2Bucket.get 第二参中业务用到的形状（range；onlyIf 未用不收） */
interface GetOptions {
  range?: R2Range;
}

/** R2Bucket.put 第二参中业务用到的形状 */
interface PutOptions {
  httpMetadata?: R2HTTPMetadata | Headers;
  customMetadata?: Record<string, string>;
}

/** headFromResponse 的可变中间结构（206 需回填 total size） */
type MutableHead = {
  size: number;
  etag: string;
  httpMetadata: R2HTTPMetadata | undefined;
  customMetadata: Record<string, string> | undefined;
};

const decoder = new TextDecoder();

export class S3R2Bucket {
  readonly #client: AwsClient;
  readonly #base: URL;

  constructor(options: S3StorageOptions) {
    this.#client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: 's3',
      region: options.region,
      // 适配器内部不做重试：短生命周期请求由调用方/上游兜底，避免
      // 上传大对象时重试放大故障
      retries: 0,
    });
    const endpoint = options.endpoint.replace(/\/+$/, '');
    // 配置了 bucket → endpoint 视为服务级（https://s3.example.com），拼上
    // bucket；未配置 → endpoint 已含 bucket（如 R2 的
    // https://<account>.r2.cloudflarestorage.com/<bucket> 或 MinIO 子路径）
    if (options.bucket === undefined || options.bucket === '') {
      this.#base = new URL(endpoint + '/');
    } else {
      this.#base = new URL(`${endpoint}/${encodeURIComponent(options.bucket)}/`);
    }
  }

  /** 对象 URL：base（含 bucket）+ 编码后的 key（逐段编码，保留 /） */
  #objectUrl(key: string): string {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return this.#base.href + encoded;
  }

  async get(key: string, options?: GetOptions): Promise<R2StoredObjectBody | null> {
    const rangeHeader = buildRangeHeader(options?.range);
    const response = await this.#client.fetch(this.#objectUrl(key), {
      method: 'GET',
      ...(rangeHeader === undefined ? {} : { headers: { Range: rangeHeader } }),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`S3 get ${key} 失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const head = headFromResponse(response);
    let slice = bytes;
    let range: R2Range | undefined;
    if (response.status === 206) {
      // 206 时 Content-Range 的 total 才是对象全大小（Content-Length 只是分片长）
      const parsed = parseContentRange(response.headers.get('content-range'), bytes.length);
      if (parsed !== undefined) {
        slice = bytes; // 已是服务端切好的分片
        range = { offset: parsed.start, length: bytes.length };
        head.size = parsed.total;
      }
    }
    return new R2StoredObjectBody({
      key,
      size: head.size,
      etag: head.etag,
      uploaded: parseDateHeader(response.headers.get('last-modified')),
      httpMetadata: head.httpMetadata,
      customMetadata: head.customMetadata,
      range,
    }, slice);
  }

  async head(key: string): Promise<R2StoredObject | null> {
    const response = await this.#client.fetch(this.#objectUrl(key), { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`S3 head ${key} 失败：HTTP ${response.status}`);
    const head = headFromResponse(response);
    return new R2StoredObject({
      key,
      size: head.size,
      etag: head.etag,
      uploaded: parseDateHeader(response.headers.get('last-modified')),
      httpMetadata: head.httpMetadata,
      customMetadata: head.customMetadata,
      range: undefined,
    });
  }

  async put(key: string, value: PutValue, options?: PutOptions): Promise<R2StoredObject> {
    const bytes = await toBytes(value);
    const headers = new Headers();
    const httpMetadata = normalizeHttpMetadata(options?.httpMetadata);
    if (httpMetadata?.contentType !== undefined) headers.set('Content-Type', httpMetadata.contentType);
    if (httpMetadata?.cacheControl !== undefined) headers.set('Cache-Control', httpMetadata.cacheControl);
    if (httpMetadata?.contentLanguage !== undefined) headers.set('Content-Language', httpMetadata.contentLanguage);
    if (httpMetadata?.contentDisposition !== undefined) headers.set('Content-Disposition', httpMetadata.contentDisposition);
    if (httpMetadata?.contentEncoding !== undefined) headers.set('Content-Encoding', httpMetadata.contentEncoding);
    for (const [name, content] of Object.entries(options?.customMetadata ?? {})) {
      headers.set(`x-amz-meta-${name.toLowerCase()}`, content);
    }
    const response = await this.#client.fetch(this.#objectUrl(key), {
      method: 'PUT',
      headers,
      body: bytes,
      // s3 服务下 aws4fetch 对 payload 默认 UNSIGNED-PAYLOAD，Uint8Array
      // body 直接签名发送，无需额外透传
    });
    if (!response.ok) throw new Error(`S3 put ${key} 失败：HTTP ${response.status}`);
    const etag = (response.headers.get('etag') ?? '').replace(/^"|"$/g, '');
    const uploaded = parseDateHeader(response.headers.get('last-modified')) ?? new Date();
    return new R2StoredObject({
      key,
      size: bytes.length,
      etag,
      uploaded,
      httpMetadata,
      customMetadata: options?.customMetadata,
      range: undefined,
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const response = await this.#client.fetch(this.#objectUrl(key), { method: 'DELETE' });
      // S3 DELETE 幂等：不存在返回 204/404 都算成功
      if (!response.ok && response.status !== 404) {
        throw new Error(`S3 delete ${key} 失败：HTTP ${response.status}`);
      }
    }
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects> {
    const limit = Math.max(1, Math.min(options?.limit ?? 1000, 1000));
    const url = new URL(this.#base.href);
    url.searchParams.set('list-type', '2');
    if (options?.prefix !== undefined) url.searchParams.set('prefix', options.prefix);
    url.searchParams.set('max-keys', String(limit));
    if (options?.cursor !== undefined) url.searchParams.set('continuation-token', options.cursor);
    const response = await this.#client.fetch(url.href, { method: 'GET' });
    if (!response.ok) throw new Error(`S3 list 失败：HTTP ${response.status}`);
    const xml = decoder.decode(await response.arrayBuffer());
    const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(match => {
      const entry = match[1] ?? '';
      return new R2StoredObject({
        key: xmlDecode(pickXml(entry, 'Key')),
        size: Number(pickXml(entry, 'Size') || 0),
        etag: pickXml(entry, 'ETag').replace(/^"|"$/g, ''),
        uploaded: new Date(pickXml(entry, 'LastModified') || Date.now()),
        httpMetadata: undefined,
        customMetadata: undefined,
        range: undefined,
      });
    });
    const truncated = pickXml(xml, 'IsTruncated') === 'true';
    const cursor = truncated ? pickXml(xml, 'NextContinuationToken') : '';
    const delimitedPrefixes = [...xml.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g)]
      .map(match => xmlDecode(match[1] ?? ''));
    // truncated 但 token 缺失按最后一页处理（防御性：S3 规范不会出现）
    if (!truncated || cursor === '') {
      return { objects, delimitedPrefixes, truncated: false };
    }
    return { objects, delimitedPrefixes, truncated: true, cursor };
  }
}

/** R2Range → HTTP Range 头；suffix 变体 → bytes=-N（业务未用，防御性支持） */
function buildRangeHeader(range: R2Range | undefined): string | undefined {
  if (range === undefined) return undefined;
  if ('suffix' in range) return `bytes=-${range.suffix}`;
  const offset = Math.max(0, range.offset ?? 0);
  return range.length === undefined
    ? `bytes=${offset}-`
    : `bytes=${offset}-${offset + Math.max(0, range.length) - 1}`;
}

/** 206 Content-Range: bytes start-end/total → 起始偏移与对象全大小 */
function parseContentRange(header: string | null, received: number): { start: number; total: number } | undefined {
  if (header === null) return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  if (!Number.isFinite(start) || start + received <= 0) return undefined;
  // total 为 *（服务端未知总长）时无法回填 size，退化为分片尺寸
  const total = match[3] === '*' ? received : Number(match[3]);
  return { start, total: Number.isFinite(total) ? total : received };
}

function headFromResponse(response: Response): MutableHead {
  const customMetadata: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-amz-meta-')) {
      customMetadata[lower.slice('x-amz-meta-'.length)] = value;
    }
  });
  const httpMetadata: R2HTTPMetadata = {};
  const contentType = response.headers.get('content-type');
  if (contentType !== null) httpMetadata.contentType = contentType;
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl !== null) httpMetadata.cacheControl = cacheControl;
  const contentLanguage = response.headers.get('content-language');
  if (contentLanguage !== null) httpMetadata.contentLanguage = contentLanguage;
  const contentDisposition = response.headers.get('content-disposition');
  if (contentDisposition !== null) httpMetadata.contentDisposition = contentDisposition;
  const contentEncoding = response.headers.get('content-encoding');
  if (contentEncoding !== null) httpMetadata.contentEncoding = contentEncoding;
  return {
    size: Number(response.headers.get('content-length') ?? 0),
    etag: (response.headers.get('etag') ?? '').replace(/^"|"$/g, ''),
    httpMetadata: Object.keys(httpMetadata).length > 0 ? httpMetadata : undefined,
    customMetadata: Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
  };
}

function parseDateHeader(value: string | null): Date {
  if (value === null) return new Date(0);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

/** 扁平 XML 片段中取第一个 <Tag> 的文本 */
function pickXml(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] ?? '';
}

/** XML 实体反转义（S3 ListObjectsV2 的 Key/Prefix 会转义 &<>'"） */
function xmlDecode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
