// PNG **结构**校验 —— 关键点是：不解码像素。
//
// 为什么不解码：对一张 8192×8192 的图做完整 PNG 解码既耗 CPU
// （Workers 上尤其昂贵），又正是解压缩炸弹的攻击面。我们需要的全部信息
// （宽、高、类型）都躺在 IHDR 里，读固定偏移的 8 个字节即可。
//
// 这一层负责的是"这个文件是不是一个结构完好的 PNG"，纹理语义规则
// （尺寸倍数、宽高比、按类型的限制）在 texture.ts 里。
//
// 对应文档：docs/rewrite/06-texture-architecture.md §4

import { LIMITS, type ErrorCode } from '@pigeon-skin/shared';

/** PNG 魔数 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 结构性关键 chunk（首字母大写＝critical）。未知的 critical chunk 必须拒绝。 */
const KNOWN_CRITICAL_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

/**
 * 显式拒绝的 ancillary chunk。
 * APNG 的 acTL 首字母小写（属于 ancillary，本该放行），但动图不是皮肤，
 * 而且能被用来放大解码成本，所以点名拒绝。
 */
const REJECTED_ANCILLARY_CHUNKS: ReadonlySet<string> = new Set(['acTL']);

export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
  /** 按出现顺序记录的 chunk 类型，便于诊断与测试 */
  readonly chunkTypes: readonly string[];
  /** 字节总长度 */
  readonly byteLength: number;
}

export type PngInspection =
  | { readonly ok: true; readonly info: PngInfo }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

// ── CRC-32（PNG 用的是标准 CRC-32，与 zlib 一致）─────────────────────────────
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

function fail(code: ErrorCode, message: string): PngInspection {
  return { ok: false, code, message };
}

/**
 * 检查一个字节序列是否结构完好的 PNG，并读出尺寸等元数据。
 *
 * 检查项（逐条对应文档里的威胁模型）：
 *   1. 8 字节魔数           → 拒绝任何非 PNG，无论 Content-Type 声称是什么
 *   2. IHDR 必须是第一块且恰好 13 字节
 *   3. chunk 遍历：长度 + 类型 + 数据 + CRC
 *   4. 每块 CRC 校验        → 拒绝损坏文件
 *   5. chunk 数量上限       → 拒绝 chunk 洪水
 *   6. 未知 critical chunk  → 拒绝（看不懂的关键块可能改变渲染）
 *   7. acTL                → 拒绝 APNG
 *   8. IEND 必须是最后一块
 *   9. IEND 之后不得有数据  → 拒绝 polyglot（PNG 后追加 ZIP/PHP 载荷）
 */
export function inspectPng(bytes: Uint8Array): PngInspection {
  // 1. 魔数
  if (bytes.length < PNG_SIGNATURE.length) {
    return fail('texture.not_png', '文件太小，不是 PNG');
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return fail('texture.not_png', 'PNG 魔数不匹配（不是 PNG 文件）');
    }
  }

  // 显式标注 number：PNG_SIGNATURE 是 as const，`.length` 的类型是字面量 8，
  // 不加标注的话 offset 会被推断成 8，后续赋值就编译不过。
  let offset: number = PNG_SIGNATURE.length;
  const chunkTypes: string[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIhdr = false;
  let sawIend = false;
  let sawIdat = false;

  while (offset < bytes.length) {
    // chunk 头需要 8 字节（长度 4 + 类型 4）
    if (offset + 8 > bytes.length) {
      return fail('texture.malformed', `chunk 头被截断（偏移 ${offset}）`);
    }

    // 5. chunk 数量上限
    if (chunkTypes.length >= LIMITS.maxPngChunks) {
      return fail('texture.malformed', `chunk 数量超过上限 ${LIMITS.maxPngChunks}`);
    }

    const dataLength =
      ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) |
       (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;

    const typeStart = offset + 4;
    let type = '';
    for (let i = 0; i < 4; i++) type += String.fromCharCode(bytes[typeStart + i]!);

    // 合理性检查：长度字段不能荒谬地大（防止越界读取与整数溢出）
    if (dataLength > bytes.length) {
      return fail('texture.malformed', `chunk ${type} 声明的长度 ${dataLength} 超过文件大小`);
    }

    const dataStart = typeStart + 4;
    const dataEnd = dataStart + dataLength;
    const crcStart = dataEnd;
    const chunkEnd = crcStart + 4;

    if (chunkEnd > bytes.length) {
      return fail('texture.malformed', `chunk ${type} 被截断`);
    }

    // 4. CRC 校验（覆盖类型 + 数据）
    const declaredCrc =
      ((bytes[crcStart]! << 24) | (bytes[crcStart + 1]! << 16) |
       (bytes[crcStart + 2]! << 8) | bytes[crcStart + 3]!) >>> 0;
    if (crc32(bytes, typeStart, dataEnd) !== declaredCrc) {
      return fail('texture.malformed', `chunk ${type} 的 CRC 校验失败`);
    }

    chunkTypes.push(type);

    // 2. IHDR 必须是第一块
    if (!sawIhdr) {
      if (type !== 'IHDR') {
        return fail('texture.malformed', `第一块必须是 IHDR，实际是 ${type}`);
      }
      if (dataLength !== 13) {
        return fail('texture.malformed', `IHDR 长度必须是 13，实际是 ${dataLength}`);
      }
      width =
        ((bytes[dataStart]! << 24) | (bytes[dataStart + 1]! << 16) |
         (bytes[dataStart + 2]! << 8) | bytes[dataStart + 3]!) >>> 0;
      height =
        ((bytes[dataStart + 4]! << 24) | (bytes[dataStart + 5]! << 16) |
         (bytes[dataStart + 6]! << 8) | bytes[dataStart + 7]!) >>> 0;
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      interlace = bytes[dataStart + 12]!;

      if (width === 0 || height === 0) {
        return fail('texture.dimension_invalid', `尺寸非法: ${width}×${height}`);
      }
      sawIhdr = true;
    } else if (type === 'IHDR') {
      return fail('texture.malformed', '出现了重复的 IHDR');
    }

    // 6. 未知 critical chunk（首字母大写表示 critical）
    const isCritical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
    if (isCritical && !KNOWN_CRITICAL_CHUNKS.has(type)) {
      return fail('texture.malformed', `未知的关键 chunk: ${type}`);
    }

    // 7. APNG
    if (REJECTED_ANCILLARY_CHUNKS.has(type)) {
      return fail('texture.animated_not_supported', `不支持动图（发现 ${type} chunk）`);
    }

    if (type === 'IDAT') sawIdat = true;

    // 8. IEND
    if (type === 'IEND') {
      if (dataLength !== 0) {
        return fail('texture.malformed', 'IEND 的数据段应为空');
      }
      sawIend = true;
      offset = chunkEnd;

      // 9. IEND 之后不得有任何字节 —— 这是 polyglot 文件（PNG 后追加其他载荷）
      if (offset !== bytes.length) {
        return fail(
          'texture.malformed',
          `IEND 之后还有 ${bytes.length - offset} 字节数据（可能是 polyglot 文件）`,
        );
      }
      break;
    }

    offset = chunkEnd;
  }

  if (!sawIhdr) return fail('texture.malformed', '缺少 IHDR');
  if (!sawIend) return fail('texture.malformed', '缺少 IEND（文件被截断）');
  if (!sawIdat) return fail('texture.malformed', '缺少 IDAT（没有像素数据）');

  return {
    ok: true,
    info: { width, height, bitDepth, colorType, interlace, chunkTypes, byteLength: bytes.length },
  };
}

/** 计算内容的 sha256（十六进制）。这就是纹理的哈希与 R2 对象键。 */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
}
