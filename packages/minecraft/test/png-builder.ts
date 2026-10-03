// 测试用 PNG 构造器 —— 能造出合法 PNG，也能造出各种**畸形** PNG。
//
// 畸形的那些才是重点：结构校验器的价值全在于拦住它们，而用真实图片
// 是造不出"CRC 损坏""IEND 后追加载荷"这类样本的。
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ChunkSpec {
  readonly type: string;
  readonly data: Uint8Array<ArrayBufferLike>;
}

function buildChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

export interface PngSpec {
  readonly width: number;
  readonly height: number;
  /** 插入到 IHDR 之后、IDAT 之前的额外 chunk */
  readonly extraChunks?: readonly ChunkSpec[];
  /** 在 IEND 之后追加的字节（模拟 polyglot 文件） */
  readonly trailingJunk?: Uint8Array;
  /** 破坏 IDAT 的 CRC（模拟损坏文件） */
  readonly corruptIdatCrc?: boolean;
  /** 省略 IEND（模拟截断文件） */
  readonly omitIend?: boolean;
  /** 省略 IHDR（模拟非法容器） */
  readonly omitIhdr?: boolean;
  /** 自定义 bitDepth / colorType，用于测试各种合法容器 */
  readonly bitDepth?: number;
  readonly colorType?: number;
  /** 重复插入的 filler chunk 数量，用于触发 chunk 数量上限 */
  readonly fillerChunks?: number;
}

// 返回 Uint8Array<ArrayBuffer> 而不是 Node 的 Buffer：
// Buffer 是 Uint8Array<ArrayBufferLike>，而生产代码接收的是 Workers 里
// `await request.arrayBuffer()` 得到的 Uint8Array<ArrayBuffer>。
// 保持测试与生产的类型一致，才能让类型检查真的有意义。
export function makePng(spec: PngSpec): Uint8Array<ArrayBuffer> {
  const { width, height } = spec;
  const bitDepth = spec.bitDepth ?? 8;
  const colorType = spec.colorType ?? 6; // RGBA

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 最小可用的像素数据：每行一个 filter 字节 + 每像素 4 字节
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = (x * 4) & 0xff;
      raw[o + 1] = (y * 4) & 0xff;
      raw[o + 2] = 0x80;
      raw[o + 3] = 0xff;
    }
  }

  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  if (!spec.omitIhdr) parts.push(buildChunk('IHDR', ihdr));

  for (const c of spec.extraChunks ?? []) parts.push(buildChunk(c.type, c.data));

  for (let i = 0; i < (spec.fillerChunks ?? 0); i++) {
    parts.push(buildChunk('tEXt', Buffer.from(`k${i}\0v${i}`, 'latin1')));
  }

  const idat = buildChunk('IDAT', deflateSync(raw));
  if (spec.corruptIdatCrc) {
    // 只动 CRC 的最后一个字节，保证结构其余部分完好
    idat[idat.length - 1] = (idat[idat.length - 1]! ^ 0xff) & 0xff;
  }
  parts.push(idat);

  if (!spec.omitIend) parts.push(buildChunk('IEND', new Uint8Array(0)));
  if (spec.trailingJunk) parts.push(Buffer.from(spec.trailingJunk));

  return Uint8Array.from(Buffer.concat(parts));
}

/** 一个最小的合法 JPEG（用于"改名的 JPEG"场景） */
export function makeFakeJpeg(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
}
