// 皮肤预览：把纹理 PNG 渲染为原版同款 isometric 双视角图。
// 渲染算法单一来源在 @pigeon-skin/minecraft/renderer.ts（texture-renderer 的 TS 移植，
// 服务端衍生图同源）；skin-renderer.ts 是本包的 canvas 适配层。
import { renderSkinDual } from '@/lib/skin-renderer.ts';
import { renderCape } from '@pigeon-skin/minecraft';

export { renderSkinDual, render2dAvatar } from '@/lib/skin-renderer.ts';

/** 从皮肤 URL 加载并渲染双视角预览，返回 canvas */
export async function renderPreviewFromUrl(
  skinUrl: string,
  isAlex: boolean,
): Promise<HTMLCanvasElement | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('skin load failed'));
    img.src = skinUrl;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return renderSkinDual(c, isAlex);
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

export async function renderCapeFromUrl(capeUrl: string, outHeight = 240): Promise<string> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('cape load failed'));
    img.src = capeUrl;
  });
  const source = document.createElement('canvas');
  source.width = img.naturalWidth; source.height = img.naturalHeight;
  const sourceContext = source.getContext('2d', { willReadFrequently: true })!;
  sourceContext.drawImage(img, 0, 0);
  const pixels = sourceContext.getImageData(0, 0, source.width, source.height);
  const rendered = renderCape({ width: source.width, height: source.height, rgba: new Uint8Array(pixels.data) }, outHeight);
  const c = document.createElement('canvas');
  c.width = rendered.width; c.height = rendered.height;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rendered.rgba), rendered.width, rendered.height), 0, 0);
  return c.toDataURL('image/png');
}
