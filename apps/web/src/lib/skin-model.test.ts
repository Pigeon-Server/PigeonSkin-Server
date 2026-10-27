// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectSkinModelFromUrl } from '@/lib/skin-model';

// jsdom 没有 Image 解码与 canvas 像素：按测试用例伪造「图片尺寸 + 读取到的像素」。
// 规则本身（透明像素坐标）在服务端 detectSkinModel 的单测里已被逐点覆盖，
// 这里验证前端版按同样坐标取样、并把失败回落为 default。

interface FakeImage { width: number; height: number }

function stubImage({ width, height }: FakeImage, pixel: (x: number, y: number) => number) {
  class FakeImage {
    width = width;
    height = height;
    crossOrigin = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('Image', FakeImage);
  const getImageData = vi.fn((x: number, y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      data[(row * w + col) * 4 + 3] = pixel(x + col, y + row);
    }
    return { data };
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), getImageData } as never);
  return getImageData;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('detectSkinModelFromUrl', () => {
  it('右臂 unused 区有不透明像素 → default', async () => {
    stubImage({ width: 64, height: 64 }, () => 255);
    expect(await detectSkinModelFromUrl('blob:skin')).toBe('default');
  });

  it('右臂 unused 区出现透明像素 → slim', async () => {
    stubImage({ width: 64, height: 64 }, (x, y) => (x === 51 && y === 17 ? 0 : 255));
    expect(await detectSkinModelFromUrl('blob:skin')).toBe('slim');
  });

  it('高清皮肤按 width/64 缩放取样(128×128)', async () => {
    const getImageData = stubImage({ width: 128, height: 128 }, () => 255);
    // (50,16) → (100,32) 在 128×128 上的缩放区
    expect(await detectSkinModelFromUrl('blob:hd')).toBe('default');
    expect(getImageData).toHaveBeenCalledWith(100, 32, 4, 8);
  });

  it('1:2 比例与非 64 倍数尺寸恒为 default', async () => {
    stubImage({ width: 64, height: 32 }, () => 0);
    expect(await detectSkinModelFromUrl('blob:legacy')).toBe('default');
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    stubImage({ width: 32, height: 32 }, () => 0);
    expect(await detectSkinModelFromUrl('blob:tiny')).toBe('default');
  });

  it('图片加载失败回落 default', async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', BrokenImage);
    expect(await detectSkinModelFromUrl('blob:broken')).toBe('default');
  });
});
