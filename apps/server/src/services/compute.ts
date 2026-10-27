import { hashPassword, verifyStoredPassword, type VerifyOptions } from '@pigeon-skin/auth';
import { sanitizeTexture, validateTexture, decodePng, encodePng, type SanitizeResult, type TextureLimits, type TextureValidation } from '@pigeon-skin/minecraft';
import type { Bindings } from '../core/env.ts';
import { AppError } from '../core/framework.ts';
import type { Live2DModelInfo } from '@pigeon-skin/shared/live2d';
import type { ErrorCode, TextureKind, TextureModel } from '@pigeon-skin/shared';

type ComputeEnv = Pick<Bindings, 'DB'> & Partial<Pick<Bindings, 'WORKLOADS'>>;

async function dispatch(env: ComputeEnv, path: string, body: BodyInit): Promise<Response> {
  const namespace = env.WORKLOADS!;
  const stub = namespace.get(namespace.idFromName(path.startsWith('/password/') || path.startsWith('/live2d?') ? crypto.randomUUID() : 'image-compute'));
  const response = await stub.fetch(`https://workload${path}`, { method: 'POST', body });
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      const body = await response.json<{ error: ErrorCode; fields?: Record<string, string> }>();
      throw new AppError(body.error, response.status as 400, undefined, body.fields);
    }
    throw new AppError('common.internal_error', 503);
  }
  return response;
}

export async function computePasswordHash(env: ComputeEnv, password: string): Promise<string> {
  if (!env.WORKLOADS) return hashPassword(password);
  return (await (await dispatch(env, '/password/hash', JSON.stringify({ password }))).json<{ hash: string }>()).hash;
}

export async function computePasswordVerify(env: ComputeEnv, password: string, stored: string, options: VerifyOptions = {}): Promise<boolean> {
  if (!env.WORKLOADS) return verifyStoredPassword(password, stored, options);
  return (await (await dispatch(env, '/password/verify', JSON.stringify({ password, stored, options }))).json<{ valid: boolean }>()).valid;
}

export async function computeSanitize(env: ComputeEnv, bytes: Uint8Array<ArrayBuffer>, kind: TextureKind | undefined, maxArea: number): Promise<SanitizeResult> {
  if (!env.WORKLOADS) return sanitizeTexture(bytes, { kind, maxArea });
  const response = await dispatch(env, `/sanitize?area=${maxArea}${kind ? `&kind=${kind}` : ''}`, bytes);
  if (response.headers.get('content-type')?.includes('application/json')) return response.json<SanitizeResult>();
  const skinModel = response.headers.get('x-image-model');
  // 皮肤必带模型:do 版本不一致导致缺 header 时宁可失败,也不要静默入库 NULL
  if (kind === 'skin' && skinModel !== 'default' && skinModel !== 'slim') {
    throw new AppError('common.internal_error', 503);
  }
  return {
    ok: true,
    bytes: new Uint8Array(await response.arrayBuffer()),
    width: Number(response.headers.get('x-image-width')),
    height: Number(response.headers.get('x-image-height')),
    ...(skinModel === 'default' || skinModel === 'slim' ? { skinModel } : {}),
  };
}

export async function computeValidateTexture(env: ComputeEnv, bytes: Uint8Array<ArrayBuffer>, target: { kind: TextureKind; model: TextureModel | null }, limits: TextureLimits): Promise<TextureValidation> {
  if (!env.WORKLOADS) return validateTexture(bytes, target, limits);
  const options = encodeURIComponent(JSON.stringify({ target, limits }));
  return (await dispatch(env, `/validate?options=${options}`, bytes)).json<TextureValidation>();
}

export async function resizePng(bytes: Uint8Array<ArrayBuffer>, size: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const decoded = await decodePng(bytes);
  if (!decoded.ok) return null;
  const { width, height, rgba } = decoded.image;
  if (width === size && height === size) return bytes;
  const resized = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const source = (Math.floor(y * height / size) * width + Math.floor(x * width / size)) * 4;
    resized.set(rgba.subarray(source, source + 4), (y * size + x) * 4);
  }
  return new Uint8Array(await encodePng(size, size, resized));
}

export async function computeResize(env: ComputeEnv, bytes: Uint8Array<ArrayBuffer>, size: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!env.WORKLOADS) return resizePng(bytes, size);
  const response = await dispatch(env, `/resize?size=${size}`, bytes);
  return new Uint8Array(await response.arrayBuffer());
}

export async function computeLive2DUpload(env: ComputeEnv, name: string, bytes: Uint8Array): Promise<Live2DModelInfo> {
  return (await dispatch(env, `/live2d?name=${encodeURIComponent(name)}`, new Blob([bytes as Uint8Array<ArrayBuffer>]))).json<Live2DModelInfo>();
}
