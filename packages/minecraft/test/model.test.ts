// 皮肤模型自动识别 —— 与 Minecraft 客户端 HttpTexture#isSlimSkin 同规则。
//
// 检测只在方形 64 倍数皮肤上进行:右臂第一层两块 unused 区
// (50,16,2×4) 与 (54,20,2×12) 任一像素透明即 slim。
import { describe, expect, it } from 'vitest';
import { decodePng } from '../src/codec.ts';
import { detectSkinModel } from '../src/model.ts';
import { sanitizeTexture } from '../src/sanitize.ts';
import { encodePng } from '../src/codec.ts';

/** 造一张 size×size 的 RGBA 皮肤:全不透明,可选在多处挖透明像素 */
function makeSkin(size: number, transparentAt: Array<[number, number]> = []): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  // 全不透明浅灰底 + 不透明 alpha 通道
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 128; rgba[i + 1] = 128; rgba[i + 2] = 128; rgba[i + 3] = 255;
  }
  for (const [x, y] of transparentAt) rgba[(y * size + x) * 4 + 3] = 0;
  return rgba;
}

/** 造一张 8bit 调色板 PNG:index 0 经 tRNS 全透明,index 1 不透明深色 */
function makeIndexedPng(size: number, indices: Uint8Array): Uint8Array<ArrayBuffer> {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, data.length);
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type));
    body.set(data, 4);
    const crcBytes = new Uint8Array(4);
    new DataView(crcBytes.buffer).setUint32(0, crc(body));
    return new Uint8Array([...length, ...body, ...crcBytes]);
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, size);
  new DataView(ihdr.buffer).setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // 调色板
  // 每行 1 字节 filter + 1 字节/像素
  const raw = new Uint8Array(size * (1 + size));
  for (let y = 0; y < size; y++) raw.set(indices.subarray(y * size, (y + 1) * size), y * (1 + size) + 1);
  const store: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const slice = raw.subarray(i, i + 65535);
    store.push(i + 65535 < raw.length ? 0 : 1, slice.length & 255, slice.length >> 8, (~slice.length) & 255, ((~slice.length) >> 8) & 255, ...slice);
  }
  let s1 = 1, s2 = 0;
  for (const byte of raw) { s1 = (s1 + byte) % 65521; s2 = (s2 + s1) % 65521; }
  const adler = ((s2 << 16) | s1) >>> 0;
  store.push((adler >>> 24) & 255, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255);
  return new Uint8Array([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Uint8Array.from([0, 0, 0, 90, 60, 30])),
    chunk('tRNS', Uint8Array.from([0])), // index 0 透明
    chunk('IDAT', new Uint8Array(store)),
    chunk('IEND', new Uint8Array(0)),
  ].flatMap(part => [...part]));
}

describe('detectSkinModel', () => {
  it('经典皮肤:右臂区全不透明 → default', () => {
    expect(detectSkinModel(64, 64, makeSkin(64))).toBe('default');
  });

  it('slim 模板:右臂 unused 区(50,16)透明 → slim', () => {
    expect(detectSkinModel(64, 64, makeSkin(64, [[50, 16]]))).toBe('slim');
  });

  it('slim 模板:右臂 unused 区(54,20)透明 → slim', () => {
    expect(detectSkinModel(64, 64, makeSkin(64, [[54, 20]]))).toBe('slim');
  });

  it('unused 区之外的透明像素不影响判定', () => {
    // 头部、腿部透明不参与:只查右臂第一层的两块空白区
    expect(detectSkinModel(64, 64, makeSkin(64, [[0, 0], [20, 30], [40, 16]]))).toBe('default');
  });

  it('64×32 等 1:2 比例恒为 default', () => {
    expect(detectSkinModel(64, 32, makeSkin(64))).toBe('default');
  });

  it('非 64 倍数尺寸恒为 default', () => {
    expect(detectSkinModel(32, 32, makeSkin(32))).toBe('default');
  });

  it('高清皮肤按 width/64 缩放判定(128×128)', () => {
    // (50,16) 在 128×128 上对应 (100,32);挖该处一个像素应为 slim
    expect(detectSkinModel(128, 128, makeSkin(128, [[100, 32]]))).toBe('slim');
    expect(detectSkinModel(128, 128, makeSkin(128))).toBe('default');
  });

  it('非方形高清皮肤(128×64)不参与 slim 判定', () => {
    expect(detectSkinModel(128, 64, makeSkin(128))).toBe('default');
  });
});

describe('sanitizeTexture — 模型判定', () => {
  /** 把 RGBA 编码成合法 PNG 字节 */
  async function png(size: number, transparentAt: Array<[number, number]>): Promise<Uint8Array<ArrayBuffer>> {
    return (await encodePng(size, size, makeSkin(size, transparentAt))) as Uint8Array<ArrayBuffer>;
  }

  it('kind=skin 时返回按像素判定的模型', async () => {
    const slimPng = await png(64, [[50, 16]]);
    const result = await sanitizeTexture(slimPng, { kind: 'skin' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skinModel).toBe('slim');
  });

  it('kind=skin 的经典皮肤返回 default', async () => {
    const result = await sanitizeTexture(await png(64, []), { kind: 'skin' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skinModel).toBe('default');
  });

  it('未指定 kind(或披风)时不返回模型', async () => {
    const bytes = await png(64, [[50, 16]]);
    const none = await sanitizeTexture(bytes);
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.skinModel).toBeUndefined();
    const cape = await sanitizeTexture(bytes, { kind: 'cape' });
    expect(cape.ok).toBe(true);
    if (cape.ok) expect(cape.skinModel).toBeUndefined();
  });

  it('旧版 22×34 披风补边成 64×64 后不会被误判成 slim', async () => {
    // 22×34 补边到 64×64:补出来的区域全透明,若没有 kind 门控会误判 slim
    const width = 22, height = 34;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 90; rgba[i + 1] = 60; rgba[i + 2] = 30; rgba[i + 3] = 255; }
    const encoded = await encodePng(width, height, rgba);
    const result = await sanitizeTexture(encoded as Uint8Array<ArrayBuffer>, { kind: 'cape' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.width, result.height]).toEqual([64, 64]);
    expect(result.skinModel).toBeUndefined();
  });

  it('调色板 + tRNS 的透明像素同样能触发 slim', async () => {
    // 调色板 PNG:index 0 经 tRNS 声明为透明,index 1 不透明。
    // 整张只有右臂 unused 区是 index 0 → 解码后 alpha 为 0,应判 slim。
    const size = 64;
    const indices = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const unused = (x >= 50 && x < 52 && y >= 16 && y < 20) || (x >= 54 && x < 56 && y >= 20 && y < 32);
        indices[y * size + x] = unused ? 0 : 1;
      }
    }
    const bytes = makeIndexedPng(size, indices);
    const decoded = await decodePng(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(detectSkinModel(decoded.image.width, decoded.image.height, decoded.image.rgba)).toBe('slim');
  });

  it('判定依据是解码后的像素,与重编码后的字节一致', async () => {
    const bytes = await png(64, [[54, 25]]);
    const sanitized = await sanitizeTexture(bytes, { kind: 'skin' });
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    const decoded = await decodePng(sanitized.bytes);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(detectSkinModel(decoded.image.width, decoded.image.height, decoded.image.rgba)).toBe(sanitized.skinModel);
    }
  });
});
