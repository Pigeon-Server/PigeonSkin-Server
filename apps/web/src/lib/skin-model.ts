// 皮肤模型前端自动判定 —— 与服务端 detectSkinModel、Minecraft 客户端
// HttpTexture#isSlimSkin 同一规则:slim(Alex)的右臂第一层比经典(Steve)
// 少占用两块区域,这些区域在 slim 皮肤里是透明的。仅方形 64 倍数参与判定,
// 高清皮肤按 scale 缩放;64×32 等 1:2 比例恒为经典。
// 服务端判定才是事实来源,这里的实现只服务上传/编辑前的即时预览。

export type SkinModel = 'default' | 'slim';

/** 右臂第一层 slim 空白区(x、y、w、h),64×64 逻辑坐标 */
const SLIM_UNUSED_AREAS = [
  { x: 50, y: 16, w: 2, h: 4 },
  { x: 54, y: 20, w: 2, h: 12 },
] as const;

/** 从图片 URL(objectURL/dataURL/同源地址)按像素判定;任何失败回落经典 */
export async function detectSkinModelFromUrl(url: string): Promise<SkinModel> {
  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('image load failed'));
      image.src = url;
    });
    const { width, height } = image;
    if (width === 0 || width !== height || width % 64 !== 0) return 'default';
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 'default';
    context.drawImage(image, 0, 0);
    const scale = width / 64;
    for (const area of SLIM_UNUSED_AREAS) {
      const data = context.getImageData(area.x * scale, area.y * scale, area.w * scale, area.h * scale).data;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] === 0) return 'slim';
      }
    }
    return 'default';
  } catch {
    return 'default';
  }
}
