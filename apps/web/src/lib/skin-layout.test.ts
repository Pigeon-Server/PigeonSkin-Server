// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adaptLegacySkin,
  captureLegacyLimbs,
  finalizeEditedSkin,
  hasBeyondLegacyContent,
  isLegacySkinSize,
  legacyLimbsUnchanged,
  legacyToSquare,
  readPngSize,
  squareToLegacy,
} from '@/lib/skin-layout';

// jsdom 没有 PNG 解码与 canvas 像素：伪造图片尺寸与 getImageData，
// canvas 写出走 toBlob 桩，测试只关心「哪些像素被搬到了哪里」。

function makePixels(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b, a] = pixel(x, y);
    const index = (y * width + x) * 4;
    data[index] = r; data[index + 1] = g; data[index + 2] = b; data[index + 3] = a;
  }
  return data;
}

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(33));
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function pixelAt(data: Uint8ClampedArray, size: number, x: number, y: number): number[] {
  const index = (y * size + x) * 4;
  return [data[index]!, data[index + 1]!, data[index + 2]!, data[index + 3]!];
}

/** 让 Image 按给定尺寸“解码”，canvas.getImageData 返回给定像素。 */
function stubCanvas(pixels: Uint8ClampedArray, width: number, height: number) {
  class FakeImage {
    width = width;
    height = height;
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('Image', FakeImage);
  // jsdom 没有对象 URL 与 ImageData
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('ImageData', class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data; this.width = width; this.height = height;
    }
  });
  const putImageData = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: pixels })),
    putImageData,
    canvas: { width, height },
  } as never);
  const toBlob = vi.fn((callback: (value: Blob | null) => void) => callback(new Blob(['png'], { type: 'image/png' })));
  HTMLCanvasElement.prototype.toBlob = toBlob as never;
  return { putImageData, toBlob };
}

function blobOf(width: number, height: number): Blob {
  return new Blob([pngHeader(width, height)], { type: 'image/png' });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('isLegacySkinSize', () => {
  it('接受 64×32 与其高清倍数', () => {
    for (const width of [64, 128, 256, 1024]) expect(isLegacySkinSize(width, width / 2)).toBe(true);
  });

  it('拒绝方形、非 64 倍数与非法尺寸', () => {
    expect(isLegacySkinSize(64, 64)).toBe(false);
    expect(isLegacySkinSize(96, 48)).toBe(false);
    expect(isLegacySkinSize(0, 0)).toBe(false);
    expect(isLegacySkinSize(64.5, 32.25)).toBe(false);
  });
});

describe('readPngSize', () => {
  it('读取 IHDR 里的宽高', () => {
    expect(readPngSize(pngHeader(1024, 512))).toEqual({ width: 1024, height: 512 });
  });

  it('非 PNG 或过短返回 null', () => {
    expect(readPngSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readPngSize(new Uint8Array(30))).toBeNull();
  });
});

describe('legacyToSquare', () => {
  it('保留上半原图，并按 1.8 规则镜像右肢到左肢槽位', () => {
    // 用坐标值当颜色，方便追踪每个像素被搬到哪里
    const source = makePixels(64, 32, (x, y) => [x, y, 0, 255]);
    const square = legacyToSquare(source, 64, 32)!;
    expect(square).not.toBeNull();
    // 上半原样
    expect(pixelAt(square, 64, 10, 5)).toEqual([10, 5, 0, 255]);
    // 左腿 front(20,52) ← 右腿 front(4,20) 的水平镜像：x 方向翻转
    expect(pixelAt(square, 64, 20, 52)).toEqual([7, 20, 0, 255]);
    expect(pixelAt(square, 64, 23, 52)).toEqual([4, 20, 0, 255]);
    // 左臂 back(44,52) ← 右臂 back(52,20) 水平镜像
    expect(pixelAt(square, 64, 44, 52)).toEqual([55, 20, 0, 255]);
  });

  it('下半其余区域保持透明', () => {
    const source = makePixels(64, 32, () => [255, 255, 255, 255]);
    const square = legacyToSquare(source, 64, 32)!;
    expect(pixelAt(square, 64, 0, 40)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(square, 64, 56, 56)).toEqual([0, 0, 0, 0]);
  });

  it('高清按 scale 放大镜像区块', () => {
    const source = makePixels(128, 64, (x, y) => [x % 256, y, 0, 255]);
    const square = legacyToSquare(source, 128, 64)!;
    // 左腿 front 起点 (40,104)；对应右腿 front (8,40) 起 8 列宽区间的镜像列
    expect(pixelAt(square, 128, 40, 104)).toEqual([15, 40, 0, 255]);
    expect(pixelAt(square, 128, 47, 104)).toEqual([8, 40, 0, 255]);
  });

  it('尺寸或缓冲不合法返回 null', () => {
    expect(legacyToSquare(new Uint8ClampedArray(64 * 32 * 4), 64, 64)).toBeNull();
    expect(legacyToSquare(new Uint8ClampedArray(16), 64, 32)).toBeNull();
  });
});

describe('squareToLegacy', () => {
  it('只保留上半部分', () => {
    const square = makePixels(64, 64, (x, y) => [x, y, 0, 255]);
    const legacy = squareToLegacy(square, 64)!;
    expect(legacy.length).toBe(64 * 32 * 4);
    expect(pixelAt(legacy, 64, 10, 5)).toEqual([10, 5, 0, 255]);
  });

  it('非法边长返回 null', () => {
    expect(squareToLegacy(new Uint8ClampedArray(64 * 64 * 4), 96)).toBeNull();
    expect(squareToLegacy(new Uint8ClampedArray(16), 64)).toBeNull();
  });
});

describe('legacyLimbsUnchanged', () => {
  it('镜像生成的左肢与快照一致', () => {
    const source = makePixels(64, 32, (x, y) => [x * 3, y * 5, 7, 255]);
    const square = legacyToSquare(source, 64, 32)!;
    const snapshot = captureLegacyLimbs(square, 64);
    expect(legacyLimbsUnchanged(square, 64, snapshot)).toBe(true);
  });

  it('改动左肢后能检测到差异', () => {
    const source = makePixels(64, 32, (x, y) => [x * 3, y * 5, 7, 255]);
    const square = legacyToSquare(source, 64, 32)!;
    const snapshot = captureLegacyLimbs(square, 64);
    square[(52 * 64 + 20) * 4] = 1;
    expect(legacyLimbsUnchanged(square, 64, snapshot)).toBe(false);
  });

  it('透明像素忽略 RGB 差异', () => {
    const source = makePixels(64, 32, () => [10, 20, 30, 0]);
    const square = legacyToSquare(source, 64, 32)!;
    const snapshot = captureLegacyLimbs(square, 64);
    square[(52 * 64 + 20) * 4] = 200;
    expect(legacyLimbsUnchanged(square, 64, snapshot)).toBe(true);
  });
});

describe('hasBeyondLegacyContent', () => {
  it('上半与左肢槽位不算越界', () => {
    const source = makePixels(64, 32, () => [1, 2, 3, 255]);
    const square = legacyToSquare(source, 64, 32)!;
    expect(hasBeyondLegacyContent(square, 64)).toBe(false);
  });

  it('下半的衣物第二层算越界', () => {
    const square = new Uint8ClampedArray(64 * 64 * 4);
    square[(40 * 64 + 8) * 4 + 3] = 255;
    expect(hasBeyondLegacyContent(square, 64)).toBe(true);
  });

  it('腿部第二层(0,48)不再被 2:1 表达', () => {
    const square = new Uint8ClampedArray(64 * 64 * 4);
    square[(48 * 64 + 0) * 4 + 3] = 255;
    expect(hasBeyondLegacyContent(square, 64)).toBe(true);
  });
});

describe('adaptLegacySkin', () => {
  it('2:1 纹理转成方块图并返回基线', async () => {
    const pixels = makePixels(64, 32, (x, y) => [x, y, 0, 255]);
    stubCanvas(pixels, 64, 32);
    const adapted = await adaptLegacySkin(blobOf(64, 32));
    expect(adapted).not.toBeNull();
    expect(adapted!.size).toBe(64);
    expect(adapted!.image).toBeInstanceOf(Blob);
  });

  it('方形纹理不参与适配', async () => {
    stubCanvas(makePixels(64, 64, () => [0, 0, 0, 255]), 64, 64);
    expect(await adaptLegacySkin(blobOf(64, 64))).toBeNull();
  });
});

describe('finalizeEditedSkin', () => {
  it('未改动左肢时折叠回 2:1', async () => {
    const pixels = makePixels(64, 32, (x, y) => [x, y, 0, 255]);
    stubCanvas(pixels, 64, 32);
    const adapted = (await adaptLegacySkin(blobOf(64, 32)))!;
    vi.restoreAllMocks();
    const square = legacyToSquare(pixels, 64, 32)!;
    stubCanvas(square, 64, 64);
    const result = await finalizeEditedSkin(new Blob(['square'], { type: 'image/png' }), adapted);
    expect(result).toBeInstanceOf(Blob);
  });

  it('左肢被单独编辑时保留方块布局', async () => {
    const pixels = makePixels(64, 32, (x, y) => [x, y, 0, 255]);
    stubCanvas(pixels, 64, 32);
    const adapted = (await adaptLegacySkin(blobOf(64, 32)))!;
    vi.restoreAllMocks();
    const square = legacyToSquare(pixels, 64, 32)!;
    square[(52 * 64 + 20) * 4] = 9;
    stubCanvas(square, 64, 64);
    const original = new Blob(['square'], { type: 'image/png' });
    expect(await finalizeEditedSkin(original, adapted)).toBe(original);
  });

  it('出现衣物第二层时保留方块布局', async () => {
    const pixels = makePixels(64, 32, (x, y) => [x, y, 0, 255]);
    stubCanvas(pixels, 64, 32);
    const adapted = (await adaptLegacySkin(blobOf(64, 32)))!;
    vi.restoreAllMocks();
    const square = legacyToSquare(pixels, 64, 32)!;
    square[(40 * 64 + 8) * 4 + 3] = 255;
    stubCanvas(square, 64, 64);
    const original = new Blob(['square'], { type: 'image/png' });
    expect(await finalizeEditedSkin(original, adapted)).toBe(original);
  });

  it('非经典布局的编辑直接原样返回', async () => {
    const original = new Blob(['square'], { type: 'image/png' });
    expect(await finalizeEditedSkin(original, null)).toBe(original);
  });
});
