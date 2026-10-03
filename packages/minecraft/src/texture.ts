// 纹理语义规则 —— 在结构校验通过之后，判断"这个尺寸对这种类型是否合法"。
//
// 规则严格照抄旧版 SkinlibController.php:222-265，因为客户端与现有内容都依赖它们：
//   宽必须是 64 的倍数、高必须是 32 的倍数
//   steve（default）：宽高比 1 或 2
//   alex（slim）：宽高比只能是 1（旧版显式拒绝 64×32）
//   cape：宽高比只能是 2
//
// 注意 22×17 会被拒绝 —— 它不满足"64 的倍数/32 的倍数"。

import { LIMITS, type ErrorCode, type TextureKind, type TextureModel } from '@pigeon-skin/shared';
import { inspectPng, sha256Hex, type PngInfo } from './png.ts';

export interface TextureLimits {
  /** 最大文件字节数 */
  readonly maxSizeBytes: number;
  /** 最大宽度 */
  readonly maxWidth: number;
  /** 最大面积（像素） */
  readonly maxArea: number;
}

export const DEFAULT_TEXTURE_LIMITS: TextureLimits = {
  maxSizeBytes: LIMITS.maxUploadSizeKb * 1024,
  maxWidth: LIMITS.maxTextureWidth,
  maxArea: LIMITS.maxTextureArea,
};

export interface ValidatedTexture {
  readonly info: PngInfo;
  /** 内容 sha256 —— 同时是公开标识与 R2 对象键 */
  readonly hash: string;
  readonly byteLength: number;
}

export type TextureValidation =
  | { readonly ok: true; readonly value: ValidatedTexture }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

function fail(code: ErrorCode, message: string): TextureValidation {
  return { ok: false, code, message };
}

/**
 * 校验一个上传的纹理文件。
 *
 * 校验顺序刻意从便宜到昂贵，且**任何像素解码都不会发生**：
 *   大小 → 结构（魔数/chunk/CRC） → 尺寸倍数 → 宽度上限 → 面积上限 → 宽高比 → 哈希
 */
export async function validateTexture(
  bytes: Uint8Array<ArrayBuffer>,
  target: { kind: TextureKind; model: TextureModel | null },
  limits: TextureLimits = DEFAULT_TEXTURE_LIMITS,
): Promise<TextureValidation> {
  // 1. 大小：在做任何解析之前拦住超大文件
  if (bytes.length === 0) {
    return fail('texture.file_missing', '文件为空');
  }
  if (bytes.length > limits.maxSizeBytes) {
    return fail(
      'texture.file_too_large',
      `文件 ${bytes.length} 字节超过上限 ${limits.maxSizeBytes} 字节`,
    );
  }

  // 2. 结构校验（含魔数、chunk 遍历、CRC、尾随数据）
  const inspection = inspectPng(bytes);
  if (!inspection.ok) return { ok: false, code: inspection.code, message: inspection.message };
  const { width, height } = inspection.info;

  // 3. 尺寸倍数
  if (width % 64 !== 0 || height % 32 !== 0) {
    return fail(
      'texture.dimension_invalid',
      `尺寸 ${width}×${height} 非法：宽必须是 64 的倍数、高必须是 32 的倍数`,
    );
  }

  // 4. 宽度上限（先于面积，给出更易理解的报错）
  if (width > limits.maxWidth) {
    return fail('texture.width_too_large', `宽度 ${width} 超过上限 ${limits.maxWidth}`);
  }

  // 5. 面积上限 —— 独立的解压缩炸弹防护。
  //    没有它的话，8192×8192 这种"宽度合法但面积灾难"的图会通过前面的检查。
  if (width * height > limits.maxArea) {
    return fail(
      'texture.dimension_invalid',
      `面积 ${width * height} 像素超过上限 ${limits.maxArea}`,
    );
  }

  // 6. 宽高比（按类型）
  const ratio = width / height;
  if (target.kind === 'cape') {
    if (ratio !== 2) {
      return fail('texture.ratio_invalid', `披风要求宽高比为 2，实际 ${ratio}（${width}×${height}）`);
    }
  } else if (target.model === 'slim') {
    if (ratio !== 1) {
      return fail(
        'texture.ratio_invalid',
        `Alex（slim）模型要求宽高比为 1，实际 ${ratio}（${width}×${height}）`,
      );
    }
  } else {
    if (ratio !== 1 && ratio !== 2) {
      return fail(
        'texture.ratio_invalid',
        `皮肤要求宽高比为 1 或 2，实际 ${ratio}（${width}×${height}）`,
      );
    }
  }

  // 7. 哈希。内容地址：哈希是存储字节的纯函数，
  //    这是 "immutable 缓存" 之所以安全、迁移之所以能机械校验的前提。
  const hash = await sha256Hex(bytes);

  return { ok: true, value: { info: inspection.info, hash, byteLength: bytes.length } };
}

/**
 * 由内容哈希推导 R2 对象键。
 *
 * 扁平布局、无分片：R2 没有按前缀的热点问题，分片买不到任何东西，
 * 却让键不再是可直接从哈希推导的 —— 而这种推导很容易在一处写对、另一处写错。
 */
export function textureObjectKey(hash: string): string {
  return `textures/${hash}.png`;
}

/** 头像衍生图的对象键 */
export function avatarObjectKey(hash: string, mode: '2d' | '3d', size: number): string {
  return mode === '3d' ? `avatars/v3/${hash}/3d/${size}.png` : `avatars/v3/${hash}/2d-${size}.png`;
}

/** 预览衍生图的对象键 */
export function previewObjectKey(hash: string): string {
  return `previews/v3/${hash}.png`;
}

/** 尺寸是否在衍生图白名单里。旧版接受任意整数，会被用来把 R2 存储撑爆。 */
export function isAllowedDerivativeSize(size: number): boolean {
  return (LIMITS.derivativeSizes as readonly number[]).includes(size);
}
