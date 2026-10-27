
import { flag, type Bindings } from './../core/env.ts';
import { withRequestCache } from '../core/request-cache.ts';
import {
  decodePng, encodePng, renderAvatar2d, renderAvatar3d, renderPreview,
  avatarObjectKey, previewObjectKey, textureObjectKey, isAllowedDerivativeSize,
  type DecodedPng,
} from '@pigeon-skin/minecraft';

import { textureRenderIdentity } from '../services/texture-access.ts';

/** 一次生成请求的解析结果 */
interface GenerateSpec {
  readonly hash: string;
  readonly key: string;
  readonly kind: 'avatar2d' | 'avatar3d' | 'preview';
  readonly size: number;
}

export class DerivativeGenerator {
  readonly #env: Bindings;
  readonly #pending = new Map<string, Promise<{ body: ArrayBuffer; status: number; headers: [string, string][] }>>();

  constructor(_state: DurableObjectState, env: Bindings) {
    this.#env = env;
  }

  fetch(request: Request): Promise<Response> { return withRequestCache(() => this.handleRequest(request)); }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const spec = parseSpec(url);
    if (url.pathname !== '/generate' || !spec) return new Response(null, { status: 404 });
    const key = `${spec.hash}:${spec.kind}:${spec.size}`;
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.generate(request).then(async response => ({ body: await response.arrayBuffer(), status: response.status, headers: [...response.headers] as [string, string][] }));
      this.#pending.set(key, pending);
    }
    try {
      const result = await pending;
      return new Response(result.body, { status: result.status, headers: result.headers });
    } finally { if (this.#pending.get(key) === pending) this.#pending.delete(key); }
  }

  private async generate(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/generate') return new Response(null, { status: 404 });

    const spec = parseSpec(url);
    if (!spec) return new Response(null, { status: 404 });

    // 1. 产物已在 R2（别的 isolate 生成过 / backfill 上传过）→ 直接回
    const existing = await this.#env.BUCKET.get(spec.key);
    if (existing) {
      return new Response(existing.body, {
        headers: { 'content-type': 'image/png', 'content-length': String(existing.size) },
      });
    }

    // Existing objects remain available while generation is disabled. The flag
    // gates all source reads and writes on a miss.
    if (!flag(this.#env.DERIVATIVES_ENABLED)) return new Response(null, { status: 404 });

    // 2. 读源纹理
    const source = await this.#env.BUCKET.get(textureObjectKey(spec.hash));
    if (!source) return new Response(null, { status: 404 });
    const sourceBytes = new Uint8Array(await source.arrayBuffer());

    const decoded = await decodePng(sourceBytes);
    if (!decoded.ok) return new Response(null, { status: 404 });
    // 预览的渲染输入含类型与模型，且它们可以在材质页改。这里的取行优先级必须
    // 与读端点判"渲染签名是否一致"时用的那份一致，否则签名一致的 URL 会配上
    // 按另一种优先级渲染出来的字节。
    const identity = spec.kind === 'preview' ? await textureRenderIdentity(this.#env, spec.hash) : null;
    const png = await render(spec, decoded.image, identity?.kind === 'cape', identity?.model === 'slim');
    if (!png) return new Response(null, { status: 404 });

    // 4. 写 R2（immutable）并回字节。写失败不影响本次响应 ——
    //    下次请求会再生成一次，DO 锁保证不会并发重。
    const bytes = new Uint8Array(png);
    await this.#env.BUCKET.put(spec.key, bytes, {
      httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
    });

    return new Response(toArrayBuffer(bytes), {
      headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) },
    });
  }
}

/** Uint8Array → 独立 ArrayBuffer（规避 TS 5.7 ArrayBufferLike 变型差异，同 codec.ts） */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.length);
  new Uint8Array(out).set(data);
  return out;
}

function parseSpec(url: URL): GenerateSpec | null {
  const hash = url.searchParams.get('hash') ?? '';
  const kind = url.searchParams.get('kind') ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;

  const m = /^avatar-(2d|3d)-(\d+)$/.exec(kind);
  if (m) {
    const size = Number(m[2]);
    if (!isAllowedDerivativeSize(size)) return null;
    return {
      hash,
      kind: m[1] === '2d' ? 'avatar2d' : 'avatar3d',
      size,
      key: avatarObjectKey(hash, m[1] as '2d' | '3d', size),
    };
  }
  if (kind === 'preview') return { hash, kind: 'preview', size: 0, key: previewObjectKey(hash) };
  return null;
}

/**
 * 查该哈希在库里的 kind 与 model 由 `textureRenderIdentity` 统一提供
 * （同一哈希可能同时有 skin 与 cape 两行：64×32 既是合法 legacy 皮肤也是合法
 * 披风尺寸，无法从内容区分，只能约定优先级：legacy 皮肤远多于披风，skin 优先）。
 * 那份优先级同时决定读端点认不认请求声明的渲染签名，所以只能有一处实现。
 */
async function render(
  spec: GenerateSpec, img: DecodedPng, isCape: boolean, isAlex: boolean,
): Promise<Uint8Array | null> {
  let out: { width: number; height: number; rgba: Uint8Array };
  switch (spec.kind) {
    case 'avatar2d':
      out = renderAvatar2d(img, spec.size);
      break;
    case 'avatar3d':
      out = renderAvatar3d(img, spec.size);
      break;
    case 'preview':
      out = renderPreview(img, isCape ? 125 : 128, isCape, isAlex);
      break;
  }
  return await encodePng(out.width, out.height, out.rgba);
}
