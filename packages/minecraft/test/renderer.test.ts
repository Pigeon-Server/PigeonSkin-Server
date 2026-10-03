import { describe, expect, it } from 'vitest';
import { SkinRenderer, type RgbaImage } from '../src/renderer.ts';

function atlas(slim: boolean, legacy = false): RgbaImage {
  const width = 64, height = legacy ? 32 : 64;
  const rgba = new Uint8Array(width * height * 4);
  const fill = (x: number, y: number, w: number, h: number, color: number[]) => {
    for (let dy = y; dy < y + h; dy++) for (let dx = x; dx < x + w; dx++) rgba.set(color, (dy * width + dx) * 4);
  };
  const cube = (u: number, v: number, w: number, h: number, d: number, n: number) => {
    fill(u + d, v, w, d, [n, 40, 60, 255]);
    fill(u + d + w, v, w, d, [n, 80, 60, 255]);
    fill(u, v + d, d, h, [n, 120, 60, 255]);
    fill(u + d, v + d, w, h, [n, 160, 60, 255]);
    fill(u + d + w, v + d, d, h, [n, 200, 60, 255]);
    fill(u + d * 2 + w, v + d, w, h, [n, 240, 60, 255]);
  };
  cube(0, 0, 8, 8, 8, 240);
  cube(16, 16, 8, 12, 4, 200);
  cube(0, 16, 4, 12, 4, 160);
  cube(40, 16, slim ? 3 : 4, 12, 4, 120);
  if (!legacy) {
    cube(16, 48, 4, 12, 4, 80);
    cube(32, 48, slim ? 3 : 4, 12, 4, 40);
    fill(40, 8, 8, 4, [10, 20, 230, 180]);
    fill(20, 36, 8, 6, [220, 20, 230, 255]);
    fill(4, 52, 4, 6, [20, 220, 230, 128]);
    fill(52, 52, slim ? 3 : 4, 6, [230, 220, 20, 255]);
  }
  return { width, height, rgba };
}
function enlarge(image: RgbaImage, scale: number): RgbaImage {
  const width = image.width * scale, height = image.height * scale;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4;
    rgba.set(image.rgba.subarray(source, source + 4), (y * width + x) * 4);
  }
  return { width, height, rgba };
}
function frame(image: RgbaImage, slim: boolean, hR: number, headOnly = false) {
  const renderer = new SkinRenderer({ ratio: 4, hR, vR: headOnly ? 0 : -25, headOnly });
  renderer.setAlex(slim);
  return renderer.render(image);
}
describe('skin preview geometry and UVs', () => {
  it.each([false, true])('preserves model proportions, UVs and overlays across HD resolutions (slim=%s)', slim => {
    const source = atlas(slim);
    for (const angle of [-45, 135]) {
      const expected = frame(source, slim, angle);
      for (const scale of [2, 4, 8]) {
        const actual = frame(enlarge(source, scale), slim, angle);
        expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
        let delta = 0;
        for (let index = 0; index < actual.rgba.length; index++) delta += Math.abs(actual.rgba[index]! - expected.rgba[index]!);
        expect(delta / actual.rgba.length).toBeLessThan(0.5);
      }
    }
  });
  it('preserves mirrored limbs on HD legacy skins', () => {
    const source = atlas(false, true), expected = frame(source, false, 135);
    const actual = frame(enlarge(source, 2), false, 135);
    expect(actual).toEqual(expected);
  });
  it.each([[0, 160], [90, 120], [180, 240], [-90, 200]])('samples the intended head face at %s degrees', (angle, green) => {
    const source = atlas(false, true);
    for (const scale of [1, 2, 4]) {
      const actual = frame(enlarge(source, scale), false, angle, true);
      const center = (Math.floor(actual.height / 2) * actual.width + Math.floor(actual.width / 2)) * 4;
      expect([...actual.rgba.subarray(center, center + 4)]).toEqual([240, green, 60, 255]);
    }
  });
});
