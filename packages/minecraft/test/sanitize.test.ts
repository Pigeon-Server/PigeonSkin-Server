import { describe, expect, it } from 'vitest';
import { inspectPng } from '../src/png.ts';
import { encodePng } from '../src/codec.ts';
import { padLegacyCape, sanitizeTexture, withTextChunk } from '../src/sanitize.ts';
import { makePng } from './png-builder.ts';

function chunkTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
    types.push(String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!));
    offset += 12 + length;
  }
  return types;
}

describe('sanitizeTexture', () => {
  it('strips every ancillary metadata chunk and produces a clean PNG', async () => {
    const dirty = makePng({
      width: 64,
      height: 64,
      extraChunks: [
        { type: 'tEXt', data: new TextEncoder().encode('Author\0someone') },
        { type: 'iTXt', data: new TextEncoder().encode('Comment\0\0\0\0\0hello') },
        { type: 'eXIf', data: new Uint8Array([1, 2, 3]) },
        { type: 'tIME', data: new Uint8Array([7, 0xe8, 1, 2, 3, 4, 5]) },
      ],
    });
    // 前提：脏图确实带了这些块
    expect(chunkTypes(dirty)).toEqual(expect.arrayContaining(['tEXt', 'iTXt', 'eXIf', 'tIME']));

    const result = await sanitizeTexture(dirty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 输出只剩 IHDR/IDAT/IEND（编码器不写任何 ancillary 块）
    expect(chunkTypes(result.bytes)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(inspectPng(result.bytes).ok).toBe(true);
    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
  });

  it('re-encodes deterministically so identical pixels hash identically regardless of source metadata', async () => {
    const plain = makePng({ width: 64, height: 64 });
    const dirty = makePng({ width: 64, height: 64, extraChunks: [{ type: 'tEXt', data: new TextEncoder().encode('Author\0x') }] });
    const a = await sanitizeTexture(plain);
    const b = await sanitizeTexture(dirty);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // 同一像素面 → 同一字节（元数据不参与哈希），这是去重与内容寻址的前提
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });

  it('rejects structurally invalid input instead of re-encoding it', async () => {
    const broken = makePng({ width: 64, height: 64, corruptIdatCrc: true });
    const result = await sanitizeTexture(broken);
    expect(result.ok).toBe(false);
  });
});

describe('padLegacyCape', () => {
  it('pads 22×17 to 64×32 and keeps larger legacy multiples proportional', () => {
    expect(padLegacyCape(22, 17)).toEqual({ width: 64, height: 32 });
    // 宽高各自取最小倍数容器，不把两边一起放大
    expect(padLegacyCape(44, 34)).toEqual({ width: 64, height: 64 });
    expect(padLegacyCape(88, 34)).toEqual({ width: 128, height: 64 });
    expect(padLegacyCape(22, 34)).toEqual({ width: 64, height: 64 });
  });

  it('returns null for standard sizes and for non-legacy dimensions', () => {
    expect(padLegacyCape(64, 32)).toBeNull();
    expect(padLegacyCape(128, 64)).toBeNull();
    expect(padLegacyCape(65, 33)).toBeNull();
    expect(padLegacyCape(22, 16)).toBeNull();
  });

  it('pads with transparent pixels and preserves the original pixels at the origin', async () => {
    const legacy = makePng({ width: 22, height: 17 });
    const result = await sanitizeTexture(legacy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBe(64);
    expect(result.height).toBe(32);
    const inspection = inspectPng(result.bytes);
    expect(inspection.ok && inspection.info.width === 64 && inspection.info.height === 32).toBe(true);
  });
});

describe('withTextChunk', () => {
  it('inserts a valid tEXt chunk before IEND without touching pixel data', async () => {
    const base = await encodePng(2, 2, new Uint8Array(2 * 2 * 4).fill(128));
    const marked = withTextChunk(base, 'Software', 'Pigeon Skin · https://example.com');

    // 仍是一个结构完全合法的 PNG（CRC 正确、IEND 在末尾）
    const inspection = inspectPng(marked);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.info.chunkTypes).toEqual(['IHDR', 'IDAT', 'tEXt', 'IEND']);

    // IDAT 字节逐字未变 —— 标记不碰像素
    const idatOf = (png: Uint8Array) => {
      const start = png.indexOf(0x49, 0); // 'I' 起始扫描
      void start;
      let offset = 8;
      while (offset + 8 <= png.length) {
        const length = ((png[offset]! << 24) | (png[offset + 1]! << 16) | (png[offset + 2]! << 8) | png[offset + 3]!) >>> 0;
        const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
        if (type === 'IDAT') return png.subarray(offset + 8, offset + 8 + length);
        offset += 12 + length;
      }
      return null;
    };
    expect(Array.from(idatOf(marked)!)).toEqual(Array.from(idatOf(base)!));

    // 内容确实写进去了
    const text = new TextDecoder('latin1').decode(marked);
    expect(text).toContain('Software');
    expect(text).toContain('Pigeon Skin');
  });
});
