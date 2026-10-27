// 材质净化 —— 规范 §2.7「Yggdrasil 服务端必须对用户上传的材质进行处理，
// 除去其中任何与位图无关的数据」。
//
// 做法是「解码像素 → 重新编码」而不是「过滤 chunk」：后者要维护一份
// ancillary 白名单，漏掉任何一种块（sPLT、hIST、iCCP、eXIf……）就等于
// 把元数据继续分发出去；前者只要编码器不写这些块，输出就天然干净。
//
// 代价是同一张图重编码后的哈希与原始文件不同，因此内容寻址以重编码后的
// 字节为准（上传流程先净化、再哈希、再入库）。

import { LIMITS, type TextureKind, type TextureModel } from '@pigeon-skin/shared';
import { decodePng, encodePng } from './codec.ts';
import { detectSkinModel } from './model.ts';
import { inspectPng } from './png.ts';

export interface SanitizeOptions {
  /** 净化对象的类型。传 'skin' 时额外计算按像素判定的模型。 */
  readonly kind?: TextureKind | undefined;
  readonly maxArea?: number | undefined;
}

export type SanitizeResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly width: number;
      readonly height: number;
      /** 皮肤模型按像素判定的结果,仅 options.kind === 'skin' 时存在 */
      readonly skinModel?: TextureModel | undefined;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * 旧版披风允许 22×17 的整数倍。规范要求服务端用透明像素把宽高补足到
 * 64×32 的整数倍后再保存（§2.7 第 2 条），否则游戏内显示会错位。
 *
 * 只在「宽是 22 的倍数且高是 17 的倍数」且不满足标准尺寸时补边；
 * 补到不小于原尺寸的最小 64×32 倍数，图像贴左上角，其余填透明。
 */
export function padLegacyCape(width: number, height: number): { width: number; height: number } | null {
  if (width % 22 !== 0 || height % 17 !== 0) return null;
  // 宽高各自取满足原尺寸的最小 64×32 倍数（规范只要求「补足到 64×32 的整数倍」，
  // 不要求两边同倍；同倍会把 22×34 这类图无谓放大到 128×64）
  const targetWidth = Math.max(64, Math.ceil(width / 64) * 64);
  const targetHeight = Math.max(32, Math.ceil(height / 32) * 32);
  if (targetWidth === width && targetHeight === height) return null;
  return { width: targetWidth, height: targetHeight };
}


/**
 * 净化一张已通过结构校验的材质：解码像素 → 必要时补边 → 重新编码。
 *
 * 不在这里做尺寸倍数/宽高比校验（那是 texture.ts 的语义规则），
 * 只负责「输出一个不携带任何原始元数据的合法 PNG」。
 */
export async function sanitizeTexture(
  bytes: Uint8Array<ArrayBuffer>,
  options: SanitizeOptions = {},
): Promise<SanitizeResult> {
  // 结构校验先行：decodePng 假定输入是合法 PNG（魔数、chunk 边界）
  const inspection = inspectPng(bytes);
  if (!inspection.ok) return { ok: false, reason: inspection.message };

  const decoded = await decodePng(bytes, options.maxArea ?? LIMITS.maxTextureArea);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };

  const { width, height, rgba } = decoded.image;
  // 模型是像素的函数,借这一次解码顺带判定。必须按 kind 门控:旧披风
  // 22×34 补边后也会变成 64×64,透明补边区会把披风误判成 slim。
  const skinModel = options.kind === 'skin' ? detectSkinModel(width, height, rgba) : undefined;
  const padded = padLegacyCape(width, height);
  const targetWidth = padded?.width ?? width;
  const targetHeight = padded?.height ?? height;
  const encoded = await encodePng(targetWidth, targetHeight, rgba, { sourceWidth: width, sourceHeight: height });
  // encodePng 的输出是自建缓冲区（Uint8Array<ArrayBuffer>），与上传入口的类型一致
  return {
    ok: true,
    bytes: encoded as Uint8Array<ArrayBuffer>,
    width: targetWidth,
    height: targetHeight,
    ...(skinModel === undefined ? {} : { skinModel }),
  };
}

/** 在已编码的 PNG 里插入一个 tEXt 块（IEND 之前）。用于下发时的站点标识。 */
export function withTextChunk(bytes: Uint8Array, keyword: string, text: string): Uint8Array {
  const typeBytes = Uint8Array.from([0x74, 0x45, 0x58, 0x74]); // 'tEXt'
  const keywordBytes = new Uint8Array(new TextEncoder().encode(keyword));
  const textBytes = new Uint8Array(new TextEncoder().encode(text));
  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  data.set(keywordBytes, 0);
  data[keywordBytes.length] = 0;
  data.set(textBytes, keywordBytes.length + 1);

  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  // CRC 覆盖类型 + 数据
  view.setUint32(8 + data.length, crc32(chunk, 4, 8 + data.length));

  // 插到 IEND 之前：IEND 固定 12 字节在文件末尾（长度 0 + 'IEND' + CRC）
  const iendStart = bytes.length - 12;
  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, iendStart), 0);
  out.set(chunk, iendStart);
  out.set(bytes.subarray(iendStart), iendStart + chunk.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
