// 最小 PNG 编码器 —— 仅用于生成测试 fixture 里真实的纹理文件。
// 不是产品代码；生产环境不做服务端图像处理（见 docs/rewrite/06）。
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

export interface PngOptions {
  /** 像素生成器；默认用坐标做个可辨识的图案 */
  pixel?: (x: number, y: number) => readonly [number, number, number, number];
  /** 允许注入额外的 ancillary chunk；用于测试"拒绝未知关键 chunk"等场景 */
  extraChunks?: Array<{ type: string; data: Uint8Array }>;
  /** 在 IEND 之后追加垃圾字节；用于测试"polyglot 尾随数据" */
  trailingJunk?: Uint8Array;
}

export function makePng(width: number, height: number, opts: PngOptions = {}): Buffer {
  const pixel = opts.pixel ?? ((x, y) => [x * 3, y * 3, (x ^ y) * 2, x % 4 === 0 ? 0 : 255]);

  // 原始扫描线：每行前置一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = r & 0xff; raw[o + 1] = g & 0xff; raw[o + 2] = b & 0xff; raw[o + 3] = a & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(opts.extraChunks ?? []).map((c) => chunk(c.type, c.data)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  if (opts.trailingJunk) parts.push(Buffer.from(opts.trailingJunk));
  return Buffer.concat(parts);
}

/** 按旧库的存储语义生成文件名：扁平目录、无扩展名、文件名即 sha256 */
export const LEGACY_TEXTURE_FILENAME_IS_HASH = true;
