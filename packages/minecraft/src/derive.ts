import { render2dAvatar, render3dAvatar, renderSkinDual, type RgbaImage } from './renderer.ts';

export interface Avatar2dResult {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** 最近邻缩放 RGBA（皮肤是像素画，平滑插值会糊掉盔甲边缘） */
function scaleNearest(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const s = (sy * sw + sx) * 4;
      const d = (y * dw + x) * 4;
      out[d] = src[s]!; out[d + 1] = src[s + 1]!;
      out[d + 2] = src[s + 2]!; out[d + 3] = src[s + 3]!;
    }
  }
  return out;
}

function toImage(img: RgbaImage): RgbaImage {
  return img;
}

/**
 * 2d 头像：原版 render2dAvatar（正面头部，含帽层），缩放到 size×size。
 * isAlex 只影响身体部件，头部两种模型相同，这里不需要。
 */
export function renderAvatar2d(img: RgbaImage, size: number): Avatar2dResult {
  const native = render2dAvatar(toImage(img));
  return { width: size, height: size, rgba: scaleNearest(native.rgba, native.width, native.height, size, size) };
}
export function renderAvatar3d(img: RgbaImage, size: number): Avatar2dResult {
  const native = render3dAvatar(img);
  return { width: size, height: size, rgba: scaleNearest(native.rgba, native.width, native.height, size, size) };
}

export interface PreviewResult {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export function renderCape(img: RgbaImage, outHeight = 200): PreviewResult {
  const width = Math.max(1, Math.trunc(outHeight * 10 / 16));
  const height = Math.max(1, Math.trunc(outHeight));
  const scale = img.width / 64;
  const stepX = img.width * 10 / 64 / width;
  const stepY = img.height * 16 / 32 / height;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const left = scale + x * stepX, right = scale + (x + 1) * stepX;
    const top = scale + y * stepY, bottom = scale + (y + 1) * stepY;
    let red = 0, green = 0, blue = 0, alpha = 0, area = 0;
    for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
      const dy = Math.min(bottom, sy + 1) - Math.max(top, sy);
      for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
        const weight = dy * (Math.min(right, sx + 1) - Math.max(left, sx));
        if (weight <= 0) continue;
        area += weight;
        if (sx < 0 || sx >= img.width || sy < 0 || sy >= img.height) continue;
        const source = (sy * img.width + sx) * 4;
        const opacity = img.rgba[source + 3]! * weight;
        red += img.rgba[source]! * opacity;
        green += img.rgba[source + 1]! * opacity;
        blue += img.rgba[source + 2]! * opacity;
        alpha += opacity;
      }
    }
    const target = (y * width + x) * 4;
    if (alpha > 0) {
      rgba[target] = Math.round(red / alpha);
      rgba[target + 1] = Math.round(green / alpha);
      rgba[target + 2] = Math.round(blue / alpha);
      rgba[target + 3] = Math.round(alpha / area);
    }
  }
  return { width, height, rgba };
}

export function renderPreview(img: RgbaImage, outWidth: number, isCape: boolean, isAlex = false): PreviewResult {
  if (isCape) return renderCape(img, Math.round(outWidth * 16 / 10));

  const dual = renderSkinDual(toImage(img), isAlex);
  const h = Math.max(1, Math.round((outWidth * dual.height) / dual.width));
  return {
    width: outWidth,
    height: h,
    rgba: scaleNearest(dual.rgba, dual.width, dual.height, outWidth, h),
  };
}
