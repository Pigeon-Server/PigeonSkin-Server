// 皮肤模型自动识别 —— 采用 Minecraft 官方 HttpTexture#isSlimSkin 的判定核心。
//
// slim(Alex)的右臂是 3px 宽,在 64×64 布局里比经典(Steve)少占用两块区域;
// 这两块在经典皮肤上属于右臂第一层的 bottom 与 back 贴图,正常绘制不会透明,
// 而官方 slim 模板里它们整块透明。因此「空白区存在透明像素 ⇒ slim」。
//
// 与 skinview3d 的 inferModelType 相比刻意少两条启发式(左臂区、纯黑/纯白区):
// 本站的 model 决定服务端渲染与协议下发的权威结果,单色经典皮肤的左臂区
// 纯黑/纯白是真实贴图,套用那两条会把它们误判成 slim。宁可保守判 default ——
// 与 vanilla 的右臂核心规则一致,误判面最小。

import type { TextureModel } from '@pigeon-skin/shared';

/** 右臂第一层 slim 空白区(x、y、w、h),64×64 逻辑坐标 */
const SLIM_UNUSED_AREAS = [
  { x: 50, y: 16, w: 2, h: 4 },  // bottom 面右侧两列
  { x: 54, y: 20, w: 2, h: 12 }, // back 面右侧两列
] as const;

/**
 * 从像素判定皮肤模型。
 *
 * 仅方形 64 倍数(64×64、128×128…)参与判定,检测区按 scale 缩放以支持
 * 高清皮肤;64×32 等 1:2 比例恒为 default。rgba 为行优先的每像素 4 字节。
 */
export function detectSkinModel(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
): TextureModel {
  if (width !== height || width % 64 !== 0) return 'default';
  const scale = width / 64;
  for (const area of SLIM_UNUSED_AREAS) {
    const x0 = area.x * scale;
    const y0 = area.y * scale;
    const x1 = x0 + area.w * scale;
    const y1 = y0 + area.h * scale;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (rgba[(y * width + x) * 4 + 3] === 0) return 'slim';
      }
    }
  }
  return 'default';
}
