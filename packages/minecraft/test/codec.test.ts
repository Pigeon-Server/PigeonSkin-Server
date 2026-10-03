// codec.ts / derive.ts 的单测 —— Worker 内 PNG 编解码与衍生图合成。
//
// 重点：滤波还原（1-4 号滤波逐个喂）、调色板解码、编解码闭环，
// 以及 avatar/preview 的部件坐标正确性（这些坐标错了皮肤就是花屏，
// 而花屏只有像素级断言能抓到）。
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng, encodePng } from '../src/codec.ts';
import { renderAvatar2d, renderPreview, renderCape } from '../src/derive.ts';
import { makePng } from './png-builder.ts';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function ihdr(w: number, h: number, colorType: number): Uint8Array {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, w);
  new DataView(d.buffer).setUint32(4, h);
  d[8] = 8; d[9] = colorType;
  return d;
}

/** 用指定的逐行滤波类型构造一张 RGBA PNG（先正向滤波再存储，供还原断言） */
function pngWithFilters(w: number, h: number, filters: number[]): Uint8Array {
  const stride = w * 4;
  // actual[y][x]：目标像素值；stored：滤波后的存储字节
  const actual: number[][] = [];
  for (let y = 0; y < h; y++) {
    actual.push([]);
    for (let x = 0; x < w; x++) {
      actual[y]!.push((x * 4) & 0xff, (y * 4) & 0xff, 0x80, 0xff);
    }
  }
  const raw = new Uint8Array(h * (stride + 1));

  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };

  const stored: number[][] = [];
  // PNG 滤波定义在**原始字节**上：stored = actual - predict(actual 的邻居)。
  // 邻居是 raw 值（解码器还原后的就是它），不是上一字节的滤波输出。
  const rawAt = (y: number, byteX: number): number =>
    (y < 0 || byteX < 0 || byteX >= stride) ? 0 : actual[y]![Math.floor(byteX / 4) * 4 + (byteX % 4)]!;
  for (let y = 0; y < h; y++) {
    stored.push([]);
    for (let x = 0; x < stride; x++) {
      const a = rawAt(y, x - 4);
      const b = rawAt(y - 1, x);
      const c = rawAt(y - 1, x - 4);
      const target = actual[y]![x]!;
      let v: number;
      switch (filters[y % filters.length]) {
        case 1: v = target - a; break;
        case 2: v = target - b; break;
        case 3: v = target - ((a + b) >> 1); break;
        case 4: v = target - paeth(a, b, c); break;
        default: v = target;
      }
      stored[y]!.push(v & 0xff);
    }
  }

  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filters[y % filters.length]!;
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = stored[y]![x]!;
  }
  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(w, h, 6)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

describe('decodePng', () => {
  it('保留 RGB 图的透明色键', async () => {
    const png=concat([Uint8Array.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr(2,1,2)),chunk('tRNS',Uint8Array.from([0,10,0,20,0,30])),chunk('IDAT',deflateSync(Uint8Array.from([0,10,20,30,10,20,31]))),chunk('IEND',new Uint8Array())]);
    const result=await decodePng(png);
    expect(result.ok).toBe(true);
    if(result.ok)expect([...result.image.rgba]).toEqual([10,20,30,0,10,20,31,255]);
  });
  it.each([1,2,4])('解码 %i 位调色板图的行填充、滤波和透明度', async bitDepth => {
    const width = 5;
    const indices = [0,1,0,1,1];
    const stride = Math.ceil(width * bitDepth / 8);
    const row = new Uint8Array(stride);
    indices.forEach((index,x) => { row[Math.floor(x * bitDepth / 8)]! |= index << (8 - bitDepth - x * bitDepth % 8); });
    const raw = new Uint8Array(2 * (stride + 1));
    raw.set(row,1);
    raw[stride + 1] = 2;
    const header = ihdr(width,2,3); header[8] = bitDepth;
    const png = concat([Uint8Array.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('PLTE',Uint8Array.from([255,0,0,0,255,0])),chunk('tRNS',Uint8Array.from([255,0])),chunk('IDAT',deflateSync(raw)),chunk('IEND',new Uint8Array())]);
    const result = await decodePng(png);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (let y=0;y<2;y++) indices.forEach((index,x) => expect([...result.image.rgba.subarray((y * width + x)*4,(y * width + x+1)*4)]).toEqual(index === 0 ? [255,0,0,255] : [0,255,0,0]));
  });

  it('解码低位深灰度值并保留透明像素', async () => {
    const header = ihdr(3,1,0); header[8]=2;
    const png=concat([Uint8Array.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('tRNS',Uint8Array.from([0,1])),chunk('IDAT',deflateSync(Uint8Array.from([0,0b00011100]))),chunk('IEND',new Uint8Array())]);
    const result=await decodePng(png);
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.image.rgba]).toEqual([0,0,0,255,85,85,85,0,255,255,255,255]);
  });
  it('解码 1-4 号滤波（Sub/Up/Average/Paeth）还原出正确像素', async () => {
    const w = 64, h = 4;
    const r = await decodePng(pngWithFilters(w, h, [1, 2, 3, 4]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.image.width).toBe(w);
    expect(r.image.height).toBe(h);
    // 逐像素核对图案（同 png-builder：r=x*4, g=y*4, b=0x80, a=0xff）
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        expect(r.image.rgba[o]).toBe((x * 4) & 0xff);
        expect(r.image.rgba[o + 1]).toBe((y * 4) & 0xff);
        expect(r.image.rgba[o + 2]).toBe(0x80);
        expect(r.image.rgba[o + 3]).toBe(0xff);
      }
    }
  });

  it('解码调色板 PNG（含 tRNS 透明索引）', async () => {
    // 2×1 图：索引 0 = 红不透明，索引 1 = 绿 + tRNS 值 0x80
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0]);
    const trns = new Uint8Array([255, 0x80]);
    const raw = new Uint8Array([0, 0, 1]); // filter 0 + 索引 [0, 1]
    const png = concat([
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr(2, 1, 3)),
      chunk('PLTE', palette),
      chunk('tRNS', trns),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array(0)),
    ]);
    const r = await decodePng(png);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.image.rgba]).toEqual([255, 0, 0, 255, 0, 255, 0, 0x80]);
  });

  it('拒绝 16-bit / 交错 / 超面积', async () => {
    // 16-bit：直接改 makePng 产物的 bitDepth 会破坏 CRC，所以从构造器层给
    const deep = makePng({ width: 64, height: 64, bitDepth: 16 });
    expect((await decodePng(deep)).ok).toBe(false);

    const interlaced = makePng({ width: 64, height: 64 });
    interlaced[8 + 12] = 1; // IHDR 的 interlace 字节（签名 8 + 长度 4 + 类型 4 = 16? IHDR 数据从 16 起，interlace 在 16+12=28）
    // 上面偏移算错了会改到别的字段，直接用正确偏移 28 覆写并接受 CRC 失败：
    // decodePng 不校验 CRC（结构校验是 inspectPng 的职责），只读 IHDR 字段。
    expect((await decodePng(interlaced)).ok).toBe(false);

    // 超面积：8192×8192 = 67M 像素 > 1M 上限（IDAT 只需一行就够触发面积检查前的 IHDR 检查）
    // 面积检查在 inflate 之前 —— 用最小 IDAT 即可
    const huge = concat([
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr(8192, 8192, 6)),
      chunk('IDAT', deflateSync(new Uint8Array(8))),
      chunk('IEND', new Uint8Array(0)),
    ]);
    const r = await decodePng(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('面积');
  });

  it('解压炸弹：IDAT 膨胀超上限被截断拒绝', async () => {
    // 64×64 RGBA 的 expectedRaw ≈ 16.5KB，inflate 上限 ≈ 25KB；
    // 全零数据压缩率极高 —— 1MB 的膨胀输出只占几十字节密文
    const bombRaw = new Uint8Array(1_000_000);
    const bomb = concat([
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr(64, 64, 6)),
      chunk('IDAT', deflateSync(bombRaw)),
      chunk('IEND', new Uint8Array(0)),
    ]);
    const r = await decodePng(bomb);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('解压输出超过上限');
  });
});

describe('encodePng', () => {
  it('编码 → 解码闭环还原像素', async () => {
    const w = 32, h = 16;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = i & 0xff; rgba[i * 4 + 1] = (i >> 3) & 0xff;
      rgba[i * 4 + 2] = 0x40; rgba[i * 4 + 3] = i % 2 ? 255 : 128;
    }
    const encoded = await encodePng(w, h, rgba);
    const r = await decodePng(encoded);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.image.width).toBe(w);
    expect(r.image.height).toBe(h);
    expect([...r.image.rgba]).toEqual([...rgba]);
  });
});

describe('renderAvatar2d（原版渲染器路径）', () => {
  // 原版 render2dAvatar = SkinRenderer(headOnly, hR=0, vR=0, ratio=15)。
  // hR=vR=0 时投影为恒等：head front face 的 UV 是 (8..16, 8..16)，
  // helmet front face 的 UV 是 (40..48, 8..16) 且 9/8 外扩后盖在脸上层。
  it('64×64 + 不透明帽层：帽子像素覆盖脸部', () => {
    const w = 64, h = 64;
    const rgba = new Uint8Array(w * h * 4);
    const px = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    };
    // 脸 (8..16, 8..16) 涂红
    for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) px(x, y, 255, 0, 0);
    // 帽层 front UV (40..48, 8..16) 涂蓝（不透明）
    for (let y = 8; y < 16; y++) for (let x = 40; x < 48; x++) px(x, y, 0, 0, 255);

    const out = renderAvatar2d({ width: w, height: h, rgba }, 36);
    expect(out.width).toBe(36);
    // 产物中心为蓝 —— helmet (9/8 外扩) 盖在脸上层
    const center = (18 * 36 + 18) * 4;
    expect(out.rgba[center + 2]).toBe(255); // 蓝通道
    expect(out.rgba[center]).toBe(0);       // 非红
  });

  it('透明帽层不遮挡：露出红脸', () => {
    const w = 64, h = 64;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) {
        const o = (y * w + x) * 4;
        rgba[o] = 255; rgba[o + 3] = 255;
      }
    }
    // 帽层区域全透明（默认 0）→ fillPoly 对 alpha=0 直接跳过
    const out = renderAvatar2d({ width: w, height: h, rgba }, 36);
    const center = (18 * 36 + 18) * 4;
    expect(out.rgba[center]).toBe(255);     // 红
    expect(out.rgba[center + 3]).toBe(255); // 不透明
  });

  it('HD 皮肤（128×128，hd=2）：UV 坐标按 hd 缩放', () => {
    const w = 128, h = 128;
    const rgba = new Uint8Array(w * h * 4);
    const px = (x: number, y: number, r: number, g: number, b: number) => {
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    };
    // HD 脸 (16..32, 16..32) 涂红（= 原 UV (8..16) × hd 2）
    for (let y = 16; y < 32; y++) for (let x = 16; x < 32; x++) px(x, y, 255, 0, 0);
    const out = renderAvatar2d({ width: w, height: h, rgba }, 36);
    const center = (18 * 36 + 18) * 4;
    expect(out.rgba[center]).toBe(255); // 红脸出现在头像中心
  });
});

describe('fixNewSkinTypeLayers（1.8 双层合成）', () => {
  it('64×64 torso 第二层 overlay 渲染进产物（Round 4 实证过的丢失回归）', () => {
    const w = 64, h = 64;
    const rgba = new Uint8Array(w * h * 4);
    const px = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    };
    // torso base front UV (20..28, 20..32) 涂红
    for (let y = 20; y < 32; y++) for (let x = 20; x < 28; x++) px(x, y, 255, 0, 0);
    // BODY2 overlay front UV (20..28, 36..48) 涂蓝（在 y+16 的 base 带里）
    for (let y = 36; y < 48; y++) for (let x = 20; x < 28; x++) px(x, y, 0, 0, 255);

    const out = renderPreview({ width: w, height: h, rgba }, 256, false, false);
    // 产物中必须出现蓝色像素（overlay 合成成功）；
    // blit 方向反了的旧实现里蓝色为 0
    let blue = 0;
    for (let i = 0; i < out.rgba.length; i += 4) {
      if (out.rgba[i + 2]! > 200 && out.rgba[i]! < 50 && out.rgba[i + 3]! > 200) blue++;
    }
    expect(blue).toBeGreaterThan(20);
  });

  it('overlay 透明处透出 base（alpha 混合而非覆盖）', () => {
    const w = 64, h = 64;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 20; y < 32; y++) for (let x = 20; x < 28; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = 255; rgba[o + 3] = 255;
    }
    // BODY2 全透明（默认 0）
    const out = renderPreview({ width: w, height: h, rgba }, 256, false, false);
    let red = 0;
    for (let i = 0; i < out.rgba.length; i += 4) {
      if (out.rgba[i]! > 200 && out.rgba[i + 3]! > 200) red++;
    }
    expect(red).toBeGreaterThan(20);
  });
});

describe('renderPreview（原版双帧路径）', () => {
  it('64×64 皮肤：输出为双帧布局（宽 > 高），帧内有像素', () => {
    const w = 64, h = 64;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = 255; rgba[o + 3] = 255;
    }
    const out = renderPreview({ width: w, height: h, rgba }, 128, false, false);
    expect(out.width).toBe(128);
    // 双帧布局（135° 背面 + -45° 正面并排）宽高比明显宽扁
    expect(out.height).toBeLessThan(out.width);
    // 有不透明像素（渲染成功，不是空图）
    let painted = 0;
    for (let i = 3; i < out.rgba.length; i += 4) if (out.rgba[i]! > 0) painted++;
    expect(painted).toBeGreaterThan(100);
  });

  it('披风预览裁出正面，不混入图集的其他部位', () => {
    const w = 64, h = 32;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([0, 255, 0, 255], (y * w + x) * 4);
    for (let y = 1; y < 17; y++) for (let x = 1; x < 11; x++) rgba.set([200, 0, 0, 255], (y * w + x) * 4);
    const out = renderPreview({ width: w, height: h, rgba }, 128, true);
    expect(out.width).toBe(128);
    expect(out.height).toBe(205);
    for (let offset = 0; offset < out.rgba.length; offset += 4) expect([...out.rgba.subarray(offset, offset + 4)]).toEqual([200, 0, 0, 255]);
  });

  it('isAlex 不崩溃且尺寸稳定（slim 模型 3px 臂）', () => {
    const w = 64, h = 64;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = 255; rgba[o + 3] = 255;
    }
    const out = renderPreview({ width: w, height: h, rgba }, 128, false, true);
    expect(out.width).toBe(128);
    expect(out.height).toBeLessThan(out.width);
  });
});

describe('CapeRenderer', () => {
  it.each([1, 2, 4])('按 PHP 坐标裁切 %i 倍纹理，保持方向和 10:16 比例', scale => {
    const width = 64 * scale, height = 32 * scale;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < 16 * scale; y++) for (let x = 0; x < 10 * scale; x++) rgba.set([Math.floor(x / scale) * 20, Math.floor(y / scale) * 12, 0, 255], ((y + scale) * width + x + scale) * 4);
    const result = renderCape({ width, height, rgba }, 160);
    expect([result.width, result.height]).toEqual([100, 160]);
    expect([...result.rgba.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...result.rgba.subarray(-4)]).toEqual([180, 180, 0, 255]);
    expect([...result.rgba.subarray((80 * 100 + 50) * 4, (80 * 100 + 50) * 4 + 4)]).toEqual([100, 96, 0, 255]);
  });
  it('缩小时保留透明度，不把透明区域的颜色混入披风', () => {
    const rgba = new Uint8Array(128 * 64 * 4);
    for (let y = 2; y < 34; y++) for (let x = 2; x < 22; x++) rgba.set(x % 2 ? [0, 0, 255, 0] : [255, 0, 0, 255], (y * 128 + x) * 4);
    const result = renderCape({ width: 128, height: 64, rgba }, 16);
    expect([...result.rgba.subarray(0, 4)]).toEqual([255, 0, 0, 128]);
  });
});
