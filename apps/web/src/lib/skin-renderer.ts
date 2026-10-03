// Blessing Skin 原版预览渲染器 —— canvas 适配层。
//
// 渲染算法本体已下沉到 @pigeon-skin/minecraft（renderer.ts，与 Worker DO/
// 迁移 CLI 完全同源，都是 bs-community/texture-renderer PHP 版的移植）。
// 本文件只做浏览器侧的像素↔canvas 转换：前端 UI 继续拿 canvas，
// 算法保持单一事实来源，服务端产物与前端预览逐像素同源。
//
// 算法要点见 packages/minecraft/src/renderer.ts 头注释。
import {
  SkinRenderer,
  type RgbaImage,
} from '@pigeon-skin/minecraft';

export interface RenderOptions {
  /** 采样密度，原版默认 7；越大越清晰 */
  ratio?: number;
  /** Alex（3px 臂） */
  isAlex: boolean;
}

function canvasToImage(skin: HTMLCanvasElement): RgbaImage {
  const ctx2d = skin.getContext('2d', { willReadFrequently: true })!;
  const width = skin.width;
  const height = skin.height;
  return { width, height, rgba: new Uint8Array(ctx2d.getImageData(0, 0, width, height).data) };
}

function imageToCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
  return c;
}

/** 单帧渲染（指定水平角）；导出给需要自定义视角的调用方 */
export function renderFrame(
  skin: HTMLCanvasElement,
  isAlex: boolean,
  opts: { ratio?: number; headOnly?: boolean; hR?: number; vR?: number } = {},
): HTMLCanvasElement {
  const r = new SkinRenderer({
    ratio: opts.ratio ?? 7,
    headOnly: opts.headOnly ?? false,
    hR: opts.hR ?? 145,
    vR: opts.vR ?? -25,
  });
  r.setAlex(isAlex);
  return imageToCanvas(r.render(canvasToImage(skin)));
}

/**
 * 组合"背面 + 正面"两帧（原版 Minecraft::renderSkin，ratio=7，135°/-45°）。
 * isAlex 传入皮肤的模型类型。
 */
export function renderSkinDual(skin: HTMLCanvasElement, isAlex: boolean): HTMLCanvasElement {
  const vp = 15, hp = 30, ip = 15;
  const front = renderFrame(skin, isAlex, { ratio: 7, hR: -45, vR: -25 });
  const back = renderFrame(skin, isAlex, { ratio: 7, hR: 135, vR: -25 });

  const canvas = document.createElement('canvas');
  canvas.width = (hp + front.width + ip) * 2;
  canvas.height = vp * 2 + front.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(back, hp, vp);
  ctx.drawImage(front, hp + front.width + ip * 2, vp);
  return canvas;
}

/** 2D 头像（正面头部特写，原版 render2dAvatar：headOnly + 无旋转，ratio=15） */
export function render2dAvatar(skin: HTMLCanvasElement, isAlex: boolean, ratio = 15): HTMLCanvasElement {
  return renderFrame(skin, isAlex, { ratio, headOnly: true, hR: 0, vR: 0 });
}
