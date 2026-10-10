// 纹理业务规则。
//
// 这一层不碰 HTTP：输入是类型化的值，失败用抛 AppError 表达。
// 好处是它可以被路由、脚本、定时任务以同样的方式调用，
// 也不需要为了测试它而去构造一个 Request。
import { createDb, scalarMax } from '@pigeon-skin/db';
import { canModifyUser, type Role, type TextureKind, type TextureModel, type TextureVisibility } from '@pigeon-skin/shared';
import { isAdmin, type AuthedUser } from '../lib.ts';
import {
  validateTexture, textureObjectKey, DEFAULT_TEXTURE_LIMITS, type TextureLimits,
} from '@pigeon-skin/minecraft';
import { bumpSitemap } from './sitemap-cache.ts';
import { AppError, fail, type Pagination } from '../framework.ts';
import { audit } from './audit.ts';
import { queueTextureSubmission } from './search-submissions.ts';
import * as repo from '../repositories/textures.ts';
import type { SqlFragment } from '../search/compile.ts';
import type { Bindings } from '../env.ts';

export interface TextureEnv {
  DB: Bindings['DB'];
  BUCKET: Bindings['BUCKET'];
}

function db(env: TextureEnv) {
  return createDb(env.DB);
}

// ── 读取 ─────────────────────────────────────────────────────────────────────

export interface ListTexturesInput {
  kind?: TextureKind | undefined;
  model?: 'default' | 'slim' | undefined;
  uploader?: number | undefined;
  /** 已编译的搜索表达式（routes/textures.ts 负责编译） */
  search?: SqlFragment | null | undefined;
  sort: 'created' | 'likes';
  official?: boolean | undefined;
  mine: boolean;
  /** 请求语言：传入时名称按译文覆盖 */
  locale?: string | undefined;
}

export async function listTextures(
  env: TextureEnv,
  viewer: AuthedUser | null,
  input: ListTexturesInput,
  page: Pagination,
) {
  const { items, total } = await repo.listTextures(
    db(env),
    {
      kind: input.kind,
      model: input.model,
      uploader: input.uploader,
      search: input.search,
      sort: input.sort,
      official: input.official,
      mine: input.mine && viewer ? viewer.id : undefined,
      viewer: viewer ? { id: viewer.id, role: viewer.role } : null,
      isAdmin: isAdmin(viewer),
    },
    page,
    input.locale,
  );
  return { items, total };
}

/**
 * 取单条纹理并做可见性判定。
 *
 * 私有纹理对无权者返回什么由设置决定（403 还是伪装成 404），
 * 这个策略属于业务规则，所以放在 service 而不是路由。
 */
export async function getTexture(
  env: TextureEnv,
  viewer: AuthedUser | null,
  id: number,
  privateStatus: number,
  locale?: string,
) {
  const texture = await repo.findTextureById(db(env), id, locale);
  if (!texture) throw fail.notFound('texture.not_found');

  const allowed = texture.visibility === 'public'
    || (viewer !== null && texture.uploaderId === viewer.id)
    || isAdmin(viewer);
  if (!allowed) {
    if (privateStatus === 404) throw fail.notFound('texture.not_found');
    throw fail.forbidden('texture.private_access_denied');
  }
  const { scoreRefundBasis: _basis, scoreAward: _award, ...visible } = texture;
  return visible;
}

// ── 上传 ─────────────────────────────────────────────────────────────────────

export interface UploadTextureInput {
  bytes: Uint8Array<ArrayBuffer>;
  name: string;
  description?: string | undefined;
  kind: TextureKind;
  model: TextureModel | null;
  visibility: TextureVisibility;
  limits: TextureLimits;
  /** 纹理名正则；留空表示不限制 */
  nameRegexp?: string | undefined;
  sourceResourceId?: number | null | undefined;
  origin?: 'original' | 'repost' | undefined;
  addToCloset?: boolean | undefined;
  allowDuplicateReuse?: boolean | undefined;
}

export interface UploadCostRates {
  perKbPublic: number;
  perKbPrivate: number;
  closetItem: number;
  /** 每次上传的奖励，从成本里减去（旧版 score_award_per_texture） */
  awardPerTexture: number;
  /** 删除或转为私有时是否回收该奖励（旧版 take_back_scores_after_deletion） */
  clawbackAward: boolean;
}

/**
 * 上传纹理。
 *
 * 顺序刻意如此，每一步的失败后果都是可诊断的：
 *   1. 校验（不解码像素）→ 失败无副作用
 *   2. 重复检测 → 失败无副作用
 *   3. 算费用
 *   4. 一个批处理里：原子扣分 + 建行（余额条件在 UPDATE 的 WHERE 里）
 *   5. 写 R2 对象
 *
 * 第 4 步先于第 5 步：若 R2 写入失败，结果是"行存在但对象缺失" ——
 * verify 与每日定时任务会检测这种状态，服务端对它返回 503。
 * 反过来会留下无人引用、难以归因的孤儿对象。
 */
export async function uploadTexture(
  env: TextureEnv,
  uploader: Pick<AuthedUser, 'id'>,
  input: UploadTextureInput,
  rates: UploadCostRates,
): Promise<{ id: number; hash: string; width: number; height: number; sizeBytes: number; scoreSpent: number; reused: boolean }> {
  assertNameMatches(input.name, input.nameRegexp);

  const validated = await validateTexture(
    input.bytes,
    { kind: input.kind, model: input.model },
    input.limits,
  );
  if (!validated.ok) {
    // 校验器的错误码本身就是 API 错误码，直接透传，不重新映射
    throw new AppError(validated.code, 422, validated.message);
  }
  const { hash, info, byteLength } = validated.value;

  const database = db(env);
  if (input.sourceResourceId != null) {
    const source = await repo.findTextureById(database, input.sourceResourceId);
    if (!source || (source.visibility !== 'public' && source.uploaderId !== uploader.id) || source.kind !== input.kind || (input.kind === 'skin' && (source.model ?? 'default') !== (input.model ?? 'default'))) {
      throw fail.invalid('common.invalid_request', { sourceResourceId: 'invalid' });
    }
  }
  const existing = await repo.findVisibleDuplicate(database, hash, uploader.id, input.visibility, input.kind, input.model);
  if (existing) {
    if (input.allowDuplicateReuse) {
      return { id: existing.id, hash, width: info.width, height: info.height, sizeBytes: byteLength, scoreSpent: 0, reused: true };
    }
    throw new AppError('texture.duplicate', 409, undefined, { existingId: String(existing.id) });
  }

  // 旧版按 KB 计费（ceil(bytes/1024)），公开与私有单价不同。
  // 旧库的 score_per_storage 默认是字符串 'true' 并被当数字 1 用 ——
  // 新设置项是真正的整数，没有这个坑。
  const sizeKb = Math.ceil(byteLength / 1024);
  const perKb = input.visibility === 'public' ? rates.perKbPublic : rates.perKbPrivate;
  const grossCost = Math.max(0, sizeKb * perKb + (input.addToCloset === false ? 0 : rates.closetItem));
  const award = Math.min(grossCost, Math.max(0, rates.awardPerTexture));
  const cost = grossCost - award;

  const now = Date.now();
  const statements = [
    env.DB.prepare('UPDATE users SET score=score-?,updated_at=? WHERE id=? AND score>=?').bind(cost, now, uploader.id, cost),
    env.DB.prepare(`INSERT INTO textures(hash,kind,model,name,uploader_id,source_resource_id,origin,size_bytes,visibility,width,height,likes,created_at,updated_at,score_refund_basis,score_award)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,? WHERE changes()>0 RETURNING id`).bind(hash, input.kind, input.model, input.name, uploader.id, input.sourceResourceId ?? null, input.origin ?? 'original', byteLength, input.visibility, info.width, info.height, now, now, cost, award),
  ];
  if (input.description) statements.push(env.DB.prepare('INSERT INTO textures_description(tid,description,updated_at) SELECT last_insert_rowid(),?,? WHERE changes()>0').bind(input.description, now));
  if (input.addToCloset !== false) statements.push(env.DB.prepare('INSERT INTO closet(user_id,texture_id,item_name,created_at,is_default) SELECT ?,last_insert_rowid(),?,?,0 WHERE changes()>0 ON CONFLICT(user_id,texture_id) DO NOTHING').bind(uploader.id, input.name, now));
  const results = await env.DB.batch(statements);
  if (!results[0]?.meta.changes) throw fail.insufficientScore();
  const id = (results[1]?.results?.[0] as { id?: number } | undefined)?.id;
  if (!id) throw fail.conflict('texture.duplicate');

  // 元数据已提交，现在写字节。对象键由哈希直接推导，无需查表。
  await env.BUCKET.put(textureObjectKey(hash), input.bytes, {
    httpMetadata: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  // 站点地图失效（公开纹理 URL 集变化）。失败不阻塞上传。
  await bumpSitemap();

  await queueTextureSubmission(env, id);
  return { id, hash, width: info.width, height: info.height, sizeBytes: byteLength, scoreSpent: cost, reused: false };
}

// ── 修改 ─────────────────────────────────────────────────────────────────────

export async function renameTexture(
  env: TextureEnv,
  actor: AuthedUser,
  id: number,
  name: string,
): Promise<void> {
  const database = db(env);
  const texture = await repo.findTextureById(database, id);
  if (!texture) throw fail.notFound('texture.not_found');
  await assertCanEdit(env, texture.uploaderId, actor);
  await repo.updateTexture(database, id, { name, updatedAt: Date.now() });
  await bumpSitemap();
  await queueTextureSubmission(env, id);
}

/**
 * 切换可见性并结算差价。
 *
 * 旧版算法：size × 单价差。公开→私有要补收，私有→公开要退还。
 * 补收同样必须在数据库层原子完成（余额条件写在 WHERE 里）。
 */
export async function setTextureVisibility(
  env: TextureEnv,
  actor: AuthedUser,
  id: number,
  visibility: TextureVisibility,
  rates: UploadCostRates,
): Promise<{ scoreDelta: number }> {
  return patchTexture(env, actor, id, { visibility }, rates, '');
}

// ── 删除 ─────────────────────────────────────────────────────────────────────
export async function patchTexture(
  env: TextureEnv,
  actor: AuthedUser,
  id: number,
  input: { name?: string | undefined; visibility?: TextureVisibility | undefined; kind?: TextureKind | undefined; model?: TextureModel | undefined },
  rates: UploadCostRates,
  nameRegexp: string,
): Promise<{ scoreDelta: number }> {
  const texture = await repo.findTextureById(db(env), id);
  if (!texture) throw fail.notFound('texture.not_found');
  await assertCanEdit(env, texture.uploaderId, actor);
  const name = typeof input.name === 'string' ? input.name : texture.name;
  const visibility = input.visibility ?? texture.visibility;
  const kind = input.kind ?? texture.kind as TextureKind;
  const model = kind === 'cape' ? null : input.model ?? (texture.model as TextureModel | null) ?? 'default';
  assertNameMatches(name, nameRegexp);
  const typeChanged = kind !== texture.kind || model !== texture.model;
  const wasPubliclyReachable = texture.visibility === 'public' || await repo.countPublicReferencesToHash(db(env), texture.hash) > 0;
  if (typeChanged) {
    const object = await env.BUCKET.get(textureObjectKey(texture.hash));
    if (!object) throw fail.notFound('texture.not_found');
    const validation = await validateTexture(new Uint8Array(await object.arrayBuffer()), { kind, model }, {
      ...DEFAULT_TEXTURE_LIMITS,
      maxSizeBytes: Math.max(DEFAULT_TEXTURE_LIMITS.maxSizeBytes, texture.sizeBytes),
      maxWidth: Math.max(DEFAULT_TEXTURE_LIMITS.maxWidth, texture.width),
    });
    if (!validation.ok) throw fail.invalid(validation.code);
  }
  if (!typeChanged && name === texture.name && visibility === texture.visibility) return { scoreDelta: 0 };
  const sizeKb = Math.ceil(texture.sizeBytes / 1024);
  const difference = rates.perKbPrivate - rates.perKbPublic;
  const governance = texture.uploaderId !== actor.id && isAdmin(actor);
  const awardValue = rates.clawbackAward ? texture.scoreAward : 0;
  const visibilityChange = !governance && visibility !== texture.visibility;
  const priceDelta = !visibilityChange ? 0 : visibility === 'private' ? sizeKb * difference : -sizeKb * difference;
  const clawback = visibilityChange && visibility === 'private' ? awardValue : 0;
  const rawDelta = priceDelta + clawback;
  const scoreDelta = rawDelta < 0 ? -Math.min(-rawDelta, texture.scoreRefundBasis) : rawDelta;
  const refundBasisDelta = priceDelta < 0 ? Math.max(-texture.scoreRefundBasis, scoreDelta) : priceDelta;
  const now = Date.now();
  const statements = [
    env.DB.prepare('UPDATE users SET score = score - ?, updated_at = ? WHERE id = ? AND (? <= 0 OR score >= ?) AND EXISTS (SELECT 1 FROM textures WHERE id = ? AND name = ? AND visibility = ? AND kind = ? AND model IS ? AND updated_at = ?)')
      .bind(scoreDelta, now, actor.id, scoreDelta, scoreDelta, id, texture.name, texture.visibility, texture.kind, texture.model, texture.updatedAt),
    env.DB.prepare(`UPDATE textures SET name=?,visibility=?,kind=?,model=?,score_refund_basis=${scalarMax('0', 'score_refund_basis+?')},score_award=CASE WHEN ?='private' AND ?=1 THEN 0 ELSE score_award END,updated_at=? WHERE id=? AND changes()>0`)
      .bind(name, visibility, kind, model, governance ? 0 : refundBasisDelta, visibility, Number(rates.clawbackAward), now, id),
  ];
  if (typeChanged) {
    statements.push(env.DB.prepare("UPDATE players SET skin_texture_id = CASE WHEN ? = 'cape' AND skin_texture_id = ? THEN NULL ELSE skin_texture_id END, cape_texture_id = CASE WHEN ? = 'skin' AND cape_texture_id = ? THEN NULL ELSE cape_texture_id END, updated_at = ? WHERE (skin_texture_id = ? OR cape_texture_id = ?) AND changes() > 0")
      .bind(kind, id, kind, id, now, id, id));
    if (kind === 'cape') statements.push(env.DB.prepare("UPDATE users SET avatar_texture_id = NULL WHERE avatar_texture_id = ? AND EXISTS (SELECT 1 FROM textures WHERE id = ? AND kind = 'cape')").bind(id, id));
  }
  const results = await env.DB.batch(statements);
  if (!results[1]?.meta.changes) {
    const current = await repo.findTextureById(db(env), id);
    if (!current) throw fail.notFound('texture.not_found');
    if (current.name === name && current.visibility === visibility && current.kind === kind && current.model === model) return { scoreDelta: 0 };
    const user = await env.DB.prepare('SELECT score FROM users WHERE id = ?').bind(actor.id).first<{ score: number }>();
    if (scoreDelta > 0 && (user?.score ?? 0) < scoreDelta) throw fail.insufficientScore();
    throw fail.conflict('texture.changed');
  }
  await bumpSitemap();
  await queueTextureSubmission(env, id);
  if (wasPubliclyReachable && !await repo.countPublicReferencesToHash(db(env), texture.hash)) {
    await (await import('./texture-access.ts')).purgeTextureDerivatives(env, texture.hash);
  }
  return { scoreDelta };
}

export async function replaceTextureContent(
  env: TextureEnv,
  actor: AuthedUser,
  id: number,
  bytes: Uint8Array<ArrayBuffer>,
  limits: TextureLimits,
  rates: UploadCostRates,
): Promise<{ hash: string; width: number; height: number; sizeBytes: number }> {
  const database = db(env);
  const texture = await repo.findTextureById(database, id);
  if (!texture) throw fail.notFound('texture.not_found');
  await assertCanEdit(env, texture.uploaderId, actor);
  if (texture.official) throw fail.forbidden('common.forbidden');

  const validation = await validateTexture(bytes, {
    kind: texture.kind as TextureKind,
    model: texture.kind === 'cape' ? null : texture.model as TextureModel,
  }, limits);
  if (!validation.ok) throw new AppError(validation.code, 422, validation.message);
  const { hash, info, byteLength } = validation.value;
  if (hash === texture.hash) return { hash, width: info.width, height: info.height, sizeBytes: byteLength };

  const governance = texture.uploaderId !== actor.id && isAdmin(actor);
  const perKb = texture.visibility === 'public' ? rates.perKbPublic : rates.perKbPrivate;
  const grossDelta = Math.ceil(byteLength / 1024) * perKb - Math.ceil(texture.sizeBytes / 1024) * perKb;
  const scoreDelta = governance ? 0 : grossDelta < 0 ? -Math.min(-grossDelta, texture.scoreRefundBasis) : grossDelta;

  await env.BUCKET.put(textureObjectKey(hash), bytes, {
    httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
  });
  const now = Date.now();
  const statements = governance ? [
    env.DB.prepare('UPDATE textures SET hash=?,width=?,height=?,size_bytes=?,updated_at=? WHERE id=? AND hash=? AND updated_at=?')
      .bind(hash, info.width, info.height, byteLength, now, id, texture.hash, texture.updatedAt),
  ] : [
    env.DB.prepare('UPDATE users SET score=score-?,updated_at=? WHERE id=? AND (?<=0 OR score>=?) AND EXISTS(SELECT 1 FROM textures WHERE id=? AND hash=? AND updated_at=?)')
      .bind(scoreDelta, now, texture.uploaderId, scoreDelta, scoreDelta, id, texture.hash, texture.updatedAt),
    env.DB.prepare(`UPDATE textures SET hash=?,width=?,height=?,size_bytes=?,score_refund_basis=${scalarMax('0', 'score_refund_basis+?')},updated_at=? WHERE id=? AND changes()>0`)
      .bind(hash, info.width, info.height, byteLength, scoreDelta, now, id),
  ];
  const changed = await env.DB.batch(statements);
  const textureChanged = governance ? !!changed[0]?.meta.changes : !!changed[1]?.meta.changes;
  if (!textureChanged) {
    if ((await repo.countReferencesToHash(database, hash)) === 0) await env.BUCKET.delete(textureObjectKey(hash));
    if (!governance && scoreDelta > 0) throw fail.insufficientScore();
    throw fail.conflict('texture.changed');
  }

  if ((await repo.countReferencesToHash(database, texture.hash)) === 0) {
    await env.BUCKET.delete(textureObjectKey(texture.hash));
  }
  if (!await repo.countPublicReferencesToHash(database, texture.hash)) await (await import('./texture-access.ts')).purgeTextureDerivatives(env, texture.hash);
  await bumpSitemap();
  await queueTextureSubmission(env, id);
  return { hash, width: info.width, height: info.height, sizeBytes: byteLength };
}

export async function deleteTexture(
  env: TextureEnv,
  actor: AuthedUser,
  id: number,
  refund: { enabled: boolean },
): Promise<void> {
  const database = db(env);
  const texture = await repo.findTextureById(database, id);
  if (!texture) throw fail.notFound('texture.not_found');
  await assertCanEdit(env, texture.uploaderId, actor);
  const wasPubliclyReachable = texture.visibility === 'public' || await repo.countPublicReferencesToHash(database, texture.hash) > 0;
  const shouldRefund = refund.enabled && texture.uploaderId === actor.id;
  const refundAmount = shouldRefund ? texture.scoreRefundBasis : 0;
  const statements = [env.DB.prepare('DELETE FROM textures WHERE id=? AND hash=? AND updated_at=? RETURNING id')
    .bind(id, texture.hash, texture.updatedAt)];
  // 退款守卫依赖上一条语句（DELETE textures）的 changes()，中间不能插其他语句
  if (shouldRefund) statements.push(env.DB.prepare('UPDATE users SET score=score+? WHERE id=? AND changes()>0').bind(refundAmount, texture.uploaderId));
  // ai_jobs 无外键：任务行随材质一起清，避免队列残留永远失败的僵尸任务
  statements.push(env.DB.prepare('DELETE FROM ai_jobs WHERE tid=?').bind(id));
  const deleted = await env.DB.batch(statements);
  if (!deleted[0]?.meta.changes) throw fail.conflict('texture.changed');
  await bumpSitemap();
  await queueTextureSubmission(env, id);

  // 管理员删除他人纹理是治理动作，留审计痕迹；用户删自己的不用记
  if (texture.uploaderId !== actor.id) {
    await audit(env, {
      actorId: actor.id, action: 'admin.texture.delete',
      targetType: 'texture', targetId: id,
      detail: `hash:${texture.hash}`,
    });
  }

  // R2 对象按哈希引用计数才删 —— 多行可能共享同一对象
  const remaining = await repo.countReferencesToHash(database, texture.hash);
  if (remaining === 0) {
    await env.BUCKET.delete(textureObjectKey(texture.hash));
  }
  if (wasPubliclyReachable && !await repo.countPublicReferencesToHash(database, texture.hash)) {
    await (await import('./texture-access.ts')).purgeTextureDerivatives(env, texture.hash);
  }
}

// ── 内部 ─────────────────────────────────────────────────────────────────────

/**
 * 纹理名正则校验。
 *
 * 运维写的正则可能是非法的，这时**拒绝上传**而不是放行 —— 放行等于
 * 配置静默失效，而失效的校验规则比没有规则更危险。
 */
function assertNameMatches(name: string, pattern: string | undefined): void {
  if (!pattern) return;
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'u');
  } catch {
    throw fail.invalid('texture.name_invalid', { name: 'invalid_config' });
  }
  if (!re.test(name)) throw fail.invalid('texture.name_invalid', { name: 'pattern_mismatch' });
}

/** 只有上传者本人或管理员能改。注意：别人的资源按"不存在"处理，避免 id 探测。 */
async function assertCanEdit(env: TextureEnv, uploaderId: number | null, actor: AuthedUser): Promise<void> {
  if (uploaderId === actor.id) return;
  if (uploaderId === null && isAdmin(actor)) return;
  if (uploaderId !== null && isAdmin(actor)) {
    const owner = await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(uploaderId).first<{ role: Role }>();
    if (owner && canModifyUser(actor.role, owner.role)) return;
  }
  throw fail.notFound('texture.not_found');
}

export { DEFAULT_TEXTURE_LIMITS };
