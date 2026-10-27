// 皮肤纹理布局适配 —— 编辑器画布统一按方形（64×64 语义）工作。
//
// 经典 2:1 纹理（64×32 及其整数倍高清皮肤）没有独立的左肢区块与衣物第二层：
// 左臂、左腿是右肢的水平镜像。直接塞进方形画布会让采样区一半落在图像外
// （身体被压扁、左肢取到不存在的区域），所以载入前先按 Minecraft 1.8 的转换
// 规则把右肢镜像到左肢槽位；保存时若这次编辑仍能用经典布局表达，就还原成
// 用户原本的 2:1，否则输出方块布局（皮肤随之成为 1.8 双层皮肤）。

interface LimbCopy {
  /** 右肢区块在经典 2:1 布局里的位置（64×32 逻辑坐标） */
  readonly sx: number;
  readonly sy: number;
  /** 左肢区块在 64×64 布局里的位置 */
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
  readonly h: number;
}

/** 左肢各面由右肢水平镜像得到，分区与 skinview-utils 的 convertSkinTo1_8 一致。 */
const LEGACY_LIMB_COPIES: readonly LimbCopy[] = [
  { sx: 4, sy: 16, dx: 20, dy: 48, w: 4, h: 4 },
  { sx: 8, sy: 16, dx: 24, dy: 48, w: 4, h: 4 },
  { sx: 0, sy: 20, dx: 24, dy: 52, w: 4, h: 12 },
  { sx: 4, sy: 20, dx: 20, dy: 52, w: 4, h: 12 },
  { sx: 8, sy: 20, dx: 16, dy: 52, w: 4, h: 12 },
  { sx: 12, sy: 20, dx: 28, dy: 52, w: 4, h: 12 },
  { sx: 44, sy: 16, dx: 36, dy: 48, w: 4, h: 4 },
  { sx: 48, sy: 16, dx: 40, dy: 48, w: 4, h: 4 },
  { sx: 40, sy: 20, dx: 40, dy: 52, w: 4, h: 12 },
  { sx: 44, sy: 20, dx: 36, dy: 52, w: 4, h: 12 },
  { sx: 48, sy: 20, dx: 32, dy: 52, w: 4, h: 12 },
  { sx: 52, sy: 20, dx: 44, dy: 52, w: 4, h: 12 },
];

type Pixels = Uint8ClampedArray | Uint8Array;

/** 可交给 ImageData 的像素缓冲：显式绑定 ArrayBuffer。 */
type OwnedPixels = Uint8ClampedArray<ArrayBuffer>;

/** 复制成自有缓冲，消除 getImageData/SharedArrayBuffer 带来的 ArrayBufferLike。 */
function owned(rgba: Uint8ClampedArray | Uint8Array): OwnedPixels {
  const copy = new Uint8ClampedArray(new ArrayBuffer(rgba.length));
  copy.set(rgba);
  return copy;
}

/** 2:1 且宽度是 64 的整数倍：64×32 及其高清倍数。 */
export function isLegacySkinSize(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && width === height * 2 && width % 64 === 0;
}

/** 从 PNG 头部读取尺寸，避免为非经典布局的皮肤做整图解码。 */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** 方块画布下半部分的左肢槽位：左腿 (16..32) 与左臂 (32..48)，高 48..64。 */
function insideLimbSlot(x: number, y: number, scale: number): boolean {
  return x >= 16 * scale && x < 48 * scale && y >= 48 * scale && y < 64 * scale;
}

/** 把 source 的区块水平镜像写进 target；两块缓冲可以有不同的行宽。 */
function mirrorRegion(
  source: Pixels, sourceWidth: number,
  target: Pixels, targetWidth: number,
  sx: number, sy: number, dx: number, dy: number, w: number, h: number,
): void {
  for (let row = 0; row < h; row++) {
    const from = (sy + row) * sourceWidth;
    const to = (dy + row) * targetWidth;
    for (let col = 0; col < w; col++) {
      const s = (from + sx + w - 1 - col) * 4;
      const d = (to + dx + col) * 4;
      target[d] = source[s]!;
      target[d + 1] = source[s + 1]!;
      target[d + 2] = source[s + 2]!;
      target[d + 3] = source[s + 3]!;
    }
  }
}

/** 经典布局铺成方形画布：上半原样保留，左肢由右肢镜像补齐，其余透明。 */
export function legacyToSquare(rgba: Pixels, width: number, height: number): Uint8ClampedArray | null {
  if (!isLegacySkinSize(width, height) || rgba.length < width * height * 4) return null;
  const scale = width / 64;
  const square = new Uint8ClampedArray(width * width * 4);
  square.set(rgba.subarray(0, width * height * 4));
  for (const copy of LEGACY_LIMB_COPIES) {
    mirrorRegion(
      rgba, width, square, width,
      copy.sx * scale, copy.sy * scale, copy.dx * scale, copy.dy * scale, copy.w * scale, copy.h * scale,
    );
  }
  return square;
}

/** 方形画布收窄成经典布局：只保留上半部分，左肢由游戏端从右肢重新镜像。 */
export function squareToLegacy(rgba: Pixels, size: number): Uint8ClampedArray | null {
  if (!Number.isInteger(size) || size <= 0 || size % 64 !== 0) return null;
  const bytes = size * (size / 2) * 4;
  if (rgba.length < bytes) return null;
  return new Uint8ClampedArray(rgba.subarray(0, bytes));
}

/** 左肢槽位的像素快照，作为「用户是否独立编辑过左肢」的基线。 */
export function captureLegacyLimbs(rgba: Pixels, size: number): Uint8ClampedArray {
  const scale = size / 64;
  let total = 0;
  for (const copy of LEGACY_LIMB_COPIES) total += copy.w * scale * copy.h * scale * 4;
  const snapshot = new Uint8ClampedArray(total);
  let offset = 0;
  for (const copy of LEGACY_LIMB_COPIES) {
    const w = copy.w * scale;
    const h = copy.h * scale;
    for (let row = 0; row < h; row++) {
      const from = ((copy.dy * scale + row) * size + copy.dx * scale) * 4;
      snapshot.set(rgba.subarray(from, from + w * 4), offset + row * w * 4);
    }
    offset += w * h * 4;
  }
  return snapshot;
}

/**
 * 两个像素是否相同。画布按预乘 alpha 存取，非全不透明像素往返后 RGB
 * 允许 0.5/alpha 量级的误差；alpha=255 时不存在这种误差，必须精确相等。
 */
function pixelsMatch(a: Pixels, aIndex: number, b: Pixels, bIndex: number): boolean {
  const alpha = a[aIndex + 3]!;
  if (alpha !== b[bIndex + 3]) return false;
  if (alpha === 0) return true;
  const tolerance = alpha === 255 ? 0 : Math.ceil(128 / alpha);
  for (let channel = 0; channel < 3; channel++) {
    if (Math.abs(a[aIndex + channel]! - b[bIndex + channel]!) > tolerance) return false;
  }
  return true;
}

/** 左肢槽位是否仍是载入时的样子（alpha 必须一致，RGB 允许画布往返误差）。 */
export function legacyLimbsUnchanged(rgba: Pixels, size: number, snapshot: Uint8ClampedArray): boolean {
  const current = captureLegacyLimbs(rgba, size);
  if (current.length !== snapshot.length) return false;
  for (let index = 0; index < current.length; index += 4) {
    if (current[index + 3] !== snapshot[index + 3]) return false;
    if (current[index + 3] === 0) continue;
    if (!pixelsMatch(current, index, snapshot, index)) return false;
  }
  return true;
}

/**
 * 是否出现了经典布局装不下的内容。
 *
 * 上半部分（64×32 逻辑坐标 y < 32）会被原样保留，任何像素都不会丢；
 * 下半部分只有左肢槽位由镜像重建，其余区域一旦有像素就说明用户画了
 * 衣物第二层或独立编辑了左肢，只能用方块布局保存。
 */
export function hasBeyondLegacyContent(rgba: Pixels, size: number): boolean {
  if (!Number.isInteger(size) || size <= 0 || size % 64 !== 0) return true;
  const scale = size / 64;
  for (let y = size / 2; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] === 0) continue;
      if (!insideLimbSlot(x, y, scale)) return true;
    }
  }
  return false;
}

export interface LegacySkinAdaptation {
  /** 交给编辑器的方块图 */
  readonly image: Blob;
  /** 方块图边长（64 的整数倍） */
  readonly size: number;
  /** 载入时左肢槽位的像素基线 */
  readonly limbs: Uint8ClampedArray;
}

interface DecodedImage {
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

async function decodeImage(blob: Blob): Promise<DecodedImage | null> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('image load failed'));
      image.src = url;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0);
    return { rgba: context.getImageData(0, 0, width, height).data, width, height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodePng(rgba: Pixels, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.putImageData(new ImageData(owned(rgba), width, height), 0, 0);
  return new Promise((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'));
}

/**
 * 载入前归一化：经典 2:1 皮肤补齐成方块画布；其余布局、解码失败都返回 null，
 * 编辑器拿原图继续。
 */
export async function adaptLegacySkin(image: Blob): Promise<LegacySkinAdaptation | null> {
  const header = readPngSize(new Uint8Array(await image.slice(0, 24).arrayBuffer()));
  if (!header || !isLegacySkinSize(header.width, header.height)) return null;
  const source = await decodeImage(image);
  if (!source || source.width !== header.width || source.height !== header.height) return null;
  const square = legacyToSquare(source.rgba, source.width, source.height);
  if (!square) return null;
  const encoded = await encodePng(square, source.width, source.width);
  if (!encoded) return null;
  return { image: encoded, size: source.width, limbs: captureLegacyLimbs(square, source.width) };
}

/**
 * 保存前收尾：这次编辑仍能用经典 2:1 表达时还原成原布局，否则保留方块图。
 *
 * 保留方块图的两种情况：画布上出现了经典布局装不下的内容（衣物第二层等），
 * 或左肢被单独编辑过 —— 2:1 里左肢只能由右肢镜像得来。只改右肢时可以折叠，
 * 游戏端会按修改后的右肢重新镜像出左肢。
 */
export async function finalizeEditedSkin(image: Blob, adaptation: LegacySkinAdaptation | null): Promise<Blob> {
  if (!adaptation) return image;
  const source = await decodeImage(image);
  if (!source || source.width !== source.height || source.width !== adaptation.size) return image;
  if (hasBeyondLegacyContent(source.rgba, source.width)) return image;
  if (!legacyLimbsUnchanged(source.rgba, source.width, adaptation.limbs)) return image;
  const legacy = squareToLegacy(source.rgba, source.width);
  const encoded = legacy && await encodePng(legacy, source.width, source.width / 2);
  return encoded ?? image;
}
