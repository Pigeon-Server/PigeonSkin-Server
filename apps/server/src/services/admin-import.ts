// 管理级纹理导入 —— 供运维 CLI / 批量导入通道使用。
//
// 与用户上传（services/textures.ts uploadTexture）的区别：
//   • 不扣积分、不入衣柜、不发搜索提交、不触发站点地图失效前的排队语义
//     （管理导入的行常在批内，站点地图由每日定时任务兜底）
//   • 幂等：同 hash + 同 uploader 的行已存在时返回 existing，不报冲突
//   • uploader 可为空（元数据行 uploader_id NULL，展示为已注销用户）
// 校验与哈希复用同一套 validateTexture —— 内容寻址不变量在此保证。
import { validateTexture, textureObjectKey, DEFAULT_TEXTURE_LIMITS } from '@pigeon-skin/minecraft';
import type { TextureKind, TextureModel, TextureVisibility } from '@pigeon-skin/shared';
import type { Bindings } from '../env.ts';
import { AppError } from '../framework.ts';
import { getSetting } from '../lib.ts';

export interface AdminImportInput {
  bytes: Uint8Array<ArrayBuffer>;
  kind: TextureKind;
  model: TextureModel | null;
  name: string;
  visibility: TextureVisibility;
  origin: 'original' | 'repost';
  uploaderId: number | null;
}

export interface AdminImportResult {
  id: number;
  hash: string;
  width: number;
  height: number;
  sizeBytes: number;
  /** true = 同 hash+uploader 行已存在，本次未写库（对象仍会被补传） */
  existing: boolean;
}

export async function adminImportTexture(env: Pick<Bindings, 'DB' | 'BUCKET'>, input: AdminImportInput): Promise<AdminImportResult> {
  if (input.name) {
    const regexp = await getSetting(env, 'texture_name_regexp');
    if (regexp && !new RegExp(regexp).test(input.name)) {
      throw new AppError('texture.name_invalid', 422);
    }
  }

  const validated = await validateTexture(
    input.bytes,
    { kind: input.kind, model: input.model },
    DEFAULT_TEXTURE_LIMITS,
  );
  if (!validated.ok) throw new AppError(validated.code, 422, validated.message);
  const { hash, info, byteLength } = validated.value;

  // R2 对象先于行：行可见时对象一定在（内容寻址键，同内容幂等覆盖）。
  // 已存在的行也补传——修复"上次 INSERT 成功但 put 失败"留下的对象缺口。
  await env.BUCKET.put(textureObjectKey(hash), input.bytes, {
    httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
  });

  // 幂等判定与 CLI 侧 textures import 一致：hash + uploader 相同即视为已导入
  const existing = await env.DB.prepare(
    'SELECT id FROM textures WHERE hash = ? AND uploader_id IS ? LIMIT 1',
  ).bind(hash, input.uploaderId).first<{ id: number }>();
  if (existing) {
    return { id: existing.id, hash, width: info.width, height: info.height, sizeBytes: byteLength, existing: true };
  }

  const now = Date.now();
  // INSERT 直写（不走用户上传的费用批处理）。RETURNING id 供响应与审计；
  // (hash, uploader_id) 无唯一约束，前置 SELECT 之外的两个并发请求可能产生
  // 重复行 —— 幂等是 best-effort，由调用方（CLI 批内按 hash 去重、运维单实例
  // 操作）保证不并发抢写。
  const result = await env.DB.prepare(
    `INSERT INTO textures (hash, kind, model, name, uploader_id, origin, size_bytes, visibility, width, height, likes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     RETURNING id`,
  ).bind(hash, input.kind, input.model, input.name, input.uploaderId, input.origin, byteLength, input.visibility, info.width, info.height, now, now).first<{ id: number }>();

  if (!result) {
    // 行写入无返回（罕见）：回读以已存在的行为准（对象此刻已就位）
    const winner = await env.DB.prepare('SELECT id, width, height, size_bytes AS sizeBytes FROM textures WHERE hash = ? AND uploader_id IS ? LIMIT 1')
      .bind(hash, input.uploaderId).first<{ id: number; width: number; height: number; sizeBytes: number }>();
    if (!winner) throw new AppError('common.internal_error', 500);
    return { id: winner.id, hash, width: winner.width, height: winner.height, sizeBytes: winner.sizeBytes, existing: true };
  }

  return { id: result.id, hash, width: info.width, height: info.height, sizeBytes: byteLength, existing: false };
}
