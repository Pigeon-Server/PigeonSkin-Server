// PNG 编解码 —— Worker 内的完整像素级解码与编码。
//
// 与 png.ts 的结构校验互补：inspectPng 只看 chunk 布局（不解码），
// 这里才真正解出像素。为什么自己写而不用 sharp：Worker/DO 运行时没有
// 原生图像库，而 Minecraft 皮肤是 PNG 的一个极小子集 ——
//   • bitDepth 8，或低位深的调色板/灰度图，非交错
//   • colorType 0(灰)/2(RGB)/3(调色板)/4(灰+α)/6(RGBA)
// 覆盖这个子集只要两三百行，且 zlib 直接用运行时自带的
// DecompressionStream/CompressionStream（workerd 与 Node ≥18 都有）。
//
// 超出子集（16-bit、交错、未知 critical chunk）一律拒绝。

import { LIMITS } from '@pigeon-skin/shared';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

// ── CRC-32（与 png.ts 同表；PNG 编码器需要，这里独立实现避免导出纠缠）───────
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

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA8，每像素 4 字节，行优先 */
  readonly rgba: Uint8Array;
}

export type DecodeResult =
  | { readonly ok: true; readonly image: DecodedPng }
  | { readonly ok: false; readonly reason: string };

/** PNG 支持的位深 → 每像素字节数查表（bitDepth 8 限定） */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Uint8Array → 独立 ArrayBuffer（复制一份，规避 TS 5.7 的 ArrayBufferLike 变型差异） */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.length);
  new Uint8Array(out).set(data);
  return out;
}

/**
 * 收集流式 decompress 的全部输出，带硬上限。
 *
 * 面积检查（IHDR 声明值）在调用前已过，但那只约束"解码需要多少"，
 * 不约束"这个 IDAT 能膨胀到多大" —— 1MB 的恶意 PNG 可以携带膨胀到
 * GB 级的流，把 DO 内存打爆。所以按 expectedRaw 的 1.5 倍 + 1KB 余量
 * 截断：正常文件永远够用，炸弹在吃掉内存前先撞上限。
 */
async function inflateZlib(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(data)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`解压输出超过上限 ${maxBytes} 字节（疑似解压炸弹）`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(data)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Paeth 预测器（PNG 规范第 6.3 节） */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 解码 IDAT 原始扫描线（含去滤波），输出 RGBA8 */
function unfilterAndConvert(
  raw: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  bitDepth: number,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
): Uint8Array {
  const channels = CHANNELS[colorType]!;
  const stride = Math.ceil(width * channels * bitDepth / 8);
  const out = new Uint8Array(width * height * 4);
  const bpp = Math.max(1, Math.ceil(channels * bitDepth / 8));

  const row = new Uint8Array(stride);
  const prevRow = new Uint8Array(stride); // 上一行**还原后**的值（Up/UpLeft 需要）

  let pos = 0;
  for (let y = 0; y < height; y++) {
    if (pos + 1 + stride > raw.length) throw new Error(`扫描线 ${y} 被截断`);
    const filter = raw[pos]!;
    pos++;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;

    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp]! : 0;
      const up = prevRow[x]!;
      const upLeft = x >= bpp ? prevRow[x - bpp]! : 0;
      let v = line[x]!;
      switch (filter) {
        case 0: break;
        case 1: v = (v + left) & 0xff; break;
        case 2: v = (v + up) & 0xff; break;
        case 3: v = (v + ((left + up) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new Error(`未知滤波类型 ${filter}`);
      }
      row[x] = v;
    }

    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const sample = bitDepth === 8 ? row[x]! : (row[Math.floor(x * bitDepth / 8)]! >> (8 - bitDepth - x * bitDepth % 8)) & ((1 << bitDepth) - 1);
      switch (colorType) {
        case 6:
          out[o] = row[x * 4]!; out[o + 1] = row[x * 4 + 1]!;
          out[o + 2] = row[x * 4 + 2]!; out[o + 3] = row[x * 4 + 3]!;
          break;
        case 2:
          out[o] = row[x * 3]!; out[o + 1] = row[x * 3 + 1]!;
          out[o + 2] = row[x * 3 + 2]!;
          out[o + 3] = trns && trns.length === 6 && out[o] === ((trns[0]! << 8) | trns[1]!) && out[o + 1] === ((trns[2]! << 8) | trns[3]!) && out[o + 2] === ((trns[4]! << 8) | trns[5]!) ? 0 : 0xff;
          break;
        case 4:
          out[o] = row[x * 2]!; out[o + 1] = row[x * 2]!;
          out[o + 2] = row[x * 2]!; out[o + 3] = row[x * 2 + 1]!;
          break;
        case 0: {
          const gray = Math.round(sample * 255 / ((1 << bitDepth) - 1));
          out[o] = gray; out[o + 1] = gray;
          out[o + 2] = gray; out[o + 3] = trns && trns.length === 2 && sample === ((trns[0]! << 8) | trns[1]!) ? 0 : 0xff;
          break;
        }
        case 3: {
          const idx = sample;
          // 索引越界 = 文件损坏：显式失败而不是静默读 0（读 0 会把
          // 坏图渲染成黑色像素，掩盖问题）
          if (idx * 3 + 2 >= palette!.length) throw new Error(`调色板索引越界: ${idx}`);
          out[o] = palette![idx * 3]!;
          out[o + 1] = palette![idx * 3 + 1]!;
          out[o + 2] = palette![idx * 3 + 2]!;
          out[o + 3] = trns && idx < trns.length ? trns[idx]! : 0xff;
          break;
        }
      }
    }

    prevRow.set(row);
  }
  return out;
}

/**
 * 解码一个 PNG 为 RGBA8。
 *
 * 输入必须已通过 inspectPng 结构校验；这里对像素面再做一次防御性检查
 * （面积上限来自 LIMITS，防止解压炸弹吃掉 DO 内存）。
 */
export async function decodePng(bytes: Uint8Array): Promise<DecodeResult> {
  try {
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: 'PNG 魔数不匹配' };
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = -1;
    let bitDepth = 8;
    const idat: Uint8Array[] = [];
    let palette: Uint8Array | null = null;
    let trns: Uint8Array | null = null;

    while (offset + 8 <= bytes.length) {
      const dataLength =
        ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) |
         (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
      const type = String.fromCharCode(
        bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!,
      );
      const dataStart = offset + 8;
      const dataEnd = dataStart + dataLength;
      if (dataEnd > bytes.length) return { ok: false, reason: `chunk ${type} 被截断` };

      const data = bytes.subarray(dataStart, dataEnd);
      switch (type) {
        case 'IHDR':
          width = (data[0]! << 24 | data[1]! << 16 | data[2]! << 8 | data[3]!) >>> 0;
          height = (data[4]! << 24 | data[5]! << 16 | data[6]! << 8 | data[7]!) >>> 0;
          bitDepth = data[8]!;
          colorType = data[9]!;
          if (!(colorType in CHANNELS)) return { ok: false, reason: `不支持的色彩类型 ${colorType}` };
          if (bitDepth !== 8 && (!([0,3].includes(colorType)) || !([1,2,4].includes(bitDepth)))) return { ok: false, reason: `不支持的位深 ${bitDepth}` };
          if (data[12] !== 0) return { ok: false, reason: '不支持交错（interlace）PNG' };
          break;
        case 'PLTE':
          palette = new Uint8Array(data);
          break;
        case 'tRNS':
          trns = new Uint8Array(data);
          break;
        case 'IDAT':
          idat.push(data);
          break;
        case 'IEND':
          offset = bytes.length; // 跳出
          continue;
      }
      offset = dataEnd + 4; // 跳过 CRC
    }

    if (!width || !height) return { ok: false, reason: '缺少 IHDR' };
    if (idat.length === 0) return { ok: false, reason: '缺少 IDAT' };
    if (colorType === 3 && !palette) return { ok: false, reason: '调色板图缺少 PLTE' };
    if (width * height > LIMITS.maxDerivativeSourceArea) {
      return { ok: false, reason: `面积 ${width * height} 超过生成上限 ${LIMITS.maxDerivativeSourceArea}` };
    }

    const total = idat.reduce((n, d) => n + d.length, 0);
    const packed = new Uint8Array(total);
    let p = 0;
    for (const d of idat) { packed.set(d, p); p += d.length; }

    const expectedRaw = height * (Math.ceil(width * CHANNELS[colorType]! * bitDepth / 8) + 1);
    const raw = await inflateZlib(packed, Math.ceil(expectedRaw * 1.5) + 1024);
    const rgba = unfilterAndConvert(raw, width, height, colorType, bitDepth, palette, trns);
    return { ok: true, image: { width, height, rgba } };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 120) };
  }
}

function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out, 4, 8 + data.length);
  view.setUint32(8 + data.length, crc);
  return out;
}

/**
 * 编码 RGBA8 为 PNG（RGB colorType 6，filter 0）。
 * 输出保证是结构合法的 PNG —— 与 inspectPng 的校验闭环互测。
 */
export async function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<Uint8Array> {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None（皮肤尺寸小，压缩率损失可忽略）
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // 压缩/滤波/交错均为 0

  const idat = await deflateZlib(raw);
  return concat([
    Uint8Array.from(PNG_SIGNATURE),
    chunkBytes('IHDR', ihdr),
    chunkBytes('IDAT', idat),
    chunkBytes('IEND', new Uint8Array(0)),
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}
