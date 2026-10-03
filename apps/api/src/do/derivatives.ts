// DerivativeGenerator —— 衍生图生成的单飞协调者。
//
// 为什么是 Durable Object：生成是"每 (hash, kind, size) 只该发生一次"的
// 写操作，而 Worker 是无状态多副本的 —— 两个 isolate 同时收到同一个
// 缺失衍生图的请求，就会各自生成一遍并竞争写 R2。DO 以 hash 为名字
// 实例化后，同名请求自动串行（input gates），天然是按哈希的分布式锁。
//
// 生成流水线：R2 查产物 → 命中直接回 → 未命中则读源纹理 → 纯 TS 解码
// （codec.ts）→ 合成（derive.ts）→ 编码 → 写 R2 → 回字节。
// 产物一旦写进 R2 就是 immutable 内容地址，此后请求不再进 DO。
//
// CPU 预算：64×64 皮肤的解码+合成+编码是毫秒级；面积超过
// LIMITS.maxDerivativeSourceArea 的源图直接拒绝（404 路径），
// 防止解压炸弹吃掉 DO 内存。

import {
  decodePng, encodePng, renderAvatar2d, renderAvatar3d, renderPreview,
  avatarObjectKey, previewObjectKey, textureObjectKey, isAllowedDerivativeSize,
  type DecodedPng,
} from '@pigeon-skin/minecraft';
import { createDb, textures } from '@pigeon-skin/db';
import { eq, sql } from 'drizzle-orm';
import { flag, type Bindings } from '../env.ts';

/** 一次生成请求的解析结果 */
interface GenerateSpec {
  readonly hash: string;
  readonly key: string;
  readonly kind: 'avatar2d' | 'avatar3d' | 'preview';
  readonly size: number;
}

export class DerivativeGenerator {
  readonly #state: DurableObjectState;
  readonly #env: Bindings;

  constructor(state: DurableObjectState, env: Bindings) {
    this.#state = state;
    this.#env = env;
  }

  /**
   * GET /generate?hash=…&kind=avatar-2d-100|avatar-3d-64|preview
   *
   * 返回产物字节（Content-Type: image/png）；无法生成时 404。
   *
   * 锁语义：input/output gates 只围绕 **storage 操作** 生效 —— 开头的
   * `storage.get('__gate__')` 就是这个 gate 点。它让同一实例上的并发
   * fetch 串行化：第一个请求做完生成前，后续请求在 gate 处排队，
   * 排到时 R2 里已有产物、直接走第 1 步返回。没有这一行的话并发请求
   * 会自由交错（产物是确定性的，last-write-wins 无差异，但会白白重复
   * 解码烧 CPU）。
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/generate') return new Response(null, { status: 404 });

    // gate 点：详见方法注释。读一个恒缺的键，成本≈0，只为挂起 gates。
    await this.#state.storage.get('__gate__');

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
    const meta = spec.kind === 'preview' ? await metaOf(this.#env, spec.hash) : null;
    const png = await render(spec, decoded.image, meta?.kind === 'cape', meta?.model === 'slim');
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
 * 查该哈希在库里的 kind 与 model。同一哈希可能同时有 skin 与 cape 两行
 * （64×32 既是合法 legacy 皮肤也是合法披风尺寸），无法从内容区分，
 * 只能约定优先级：legacy 皮肤远多于披风，skin 优先。
 */
async function metaOf(
  env: Bindings, hash: string,
): Promise<{ kind: 'skin' | 'cape'; model: 'default' | 'slim' }> {
  const [row] = await createDb(env.DB)
    .select({ kind: textures.kind, model: textures.model })
    .from(textures)
    .where(eq(textures.hash, hash))
    .orderBy(sql`(${textures.kind} = 'skin') DESC`)
    .limit(1);
  return {
    kind: (row?.kind as 'skin' | 'cape' | undefined) ?? 'skin',
    model: (row?.model as 'default' | 'slim' | null | undefined) ?? 'default',
  };
}

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
