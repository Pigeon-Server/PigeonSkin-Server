// 收藏与举报业务规则。
//
// 收藏在旧版里同时承担"喜欢"的职责：textures.likes 就是收藏人数，
// 上传时自动收藏自己所以初始为 1。这里保留同一语义，并且把
// "删行 + likes 增减 + 积分结算"收在一处，避免计数漂移。
import { and, eq, gt, sql } from 'drizzle-orm';
import { scalarMax, createDb, notifications, reports, users } from '@pigeon-skin/db';
import { textureObjectKey } from '@pigeon-skin/minecraft';
import { AppError, fail } from '../framework.ts';
import { isAdminRole } from './authorization.ts';
import type { Role } from '@pigeon-skin/shared';
import { audit } from './audit.ts';
import * as repo from '../repositories/social.ts';
import type { SqlFragment } from '../search/compile.ts';
import * as textureRepo from '../repositories/textures.ts';
import type { Bindings } from '../env.ts';

export interface SocialEnv {
  DB: Bindings['DB'];
  BUCKET: Bindings['BUCKET'];
}

function db(env: SocialEnv) {
  return createDb(env.DB);
}

export interface SocialRates {
  perClosetItem: number;
  perLikeAward: number;
  reporterReward: number;
  refundOnDelete: boolean;
  /** 提交举报时的积分变动。负数是"押金"，被驳回时不退（旧版 reporter_score_modification） */
  reporterScoreDelta: number;
}

// ── 收藏 ─────────────────────────────────────────────────────────────────────

export async function listCloset(
  env: SocialEnv,
  userId: number,
  filter: { category?: string | undefined; search?: SqlFragment | null | undefined; page?: number | undefined; perPage?: number | undefined },
) {
  return repo.listCloset(db(env), userId, filter);
}

export async function collectTexture(
  env: SocialEnv,
  actor: { id: number; role: string },
  textureId: number,
  name: string | undefined,
  rates: SocialRates,
): Promise<{ scoreSpent: number }> {
  const database = db(env);
  const texture = await textureRepo.findTextureById(database, textureId);
  if (!texture) throw fail.notFound('texture.not_found');

  // 私有纹理只有所有者与管理员能收藏（旧版同此）
  if (texture.visibility === 'private'
      && texture.uploaderId !== actor.id
      && !isAdminRole(actor.role as Role)) {
    throw fail.forbidden('closet.texture_private');
  }

  if (await repo.findClosetEntry(database, actor.id, textureId)) {
    throw fail.conflict('closet.already_collected');
  }

  const now = Date.now();
  const itemName = name?.trim() || texture.name;
  const official = texture.official;
  const cost = official ? 0 : rates.perClosetItem;

  // 扣费、建行、likes+1 在同一个批处理里：计数与行不可能漂移，
  // 余额也不会被并发请求刷穿（余额条件写在 UPDATE 的 WHERE 里）。
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET score = score - ? WHERE id = ? AND score >= ?`)
      .bind(cost, actor.id, cost),
    env.DB.prepare(
      `INSERT INTO closet (user_id, texture_id, item_name, created_at, is_default)
       SELECT ?, ?, ?, ?, ? WHERE changes() > 0`,
    ).bind(actor.id, textureId, itemName, now, official ? 1 : 0),
    env.DB.prepare(`UPDATE textures SET likes = likes + 1 WHERE id = ? AND changes() > 0`)
      .bind(textureId),
  ]);

  if ((results[0]?.meta.changes ?? 0) === 0) throw new AppError('closet.insufficient_score', 402);

  // 收藏别人的纹理要给上传者奖励（旧版的 score_award_per_like，默认 0）
  if (rates.perLikeAward > 0 && texture.uploaderId && texture.uploaderId !== actor.id) {
    await env.DB.prepare(`UPDATE users SET score = score + ? WHERE id = ?`)
      .bind(rates.perLikeAward, texture.uploaderId).run();
  }

  return { scoreSpent: cost };
}

export async function renameClosetEntry(
  env: SocialEnv,
  userId: number,
  textureId: number,
  name: string,
): Promise<void> {
  const ok = await repo.renameClosetEntry(db(env), userId, textureId, name.trim() || null);
  if (!ok) throw fail.notFound('closet.not_found');
}

export async function removeClosetEntry(
  env: SocialEnv,
  actor: { id: number; role: string },
  textureId: number,
  rates: SocialRates,
): Promise<void> {
  const database = db(env);
  const entry = await repo.deleteClosetEntry(database, actor.id, textureId);
  if (!entry) throw fail.notFound('closet.not_found');

  const refund = rates.refundOnDelete && !entry.isDefault ? rates.perClosetItem : 0;

  // likes 用 MAX(0, …) 兜底：旧库迁移来的 likes 可能高于真实收藏人数
  // （旧 user_closet 表没有主键，曾有重复行），直接减会变负数。
  const statements = [
    env.DB.prepare(`DELETE FROM closet WHERE user_id = ? AND texture_id = ?`)
      .bind(actor.id, textureId),
    env.DB.prepare(`UPDATE textures SET likes = ${scalarMax('0', 'likes - 1')} WHERE id = ? AND changes() > 0`)
      .bind(textureId),
  ];
  if (refund > 0) {
    statements.push(
      env.DB.prepare(`UPDATE users SET score = score + ? WHERE id = ? AND changes() > 0`).bind(refund, actor.id),
    );
  }
  const results = await env.DB.batch(statements);
  if (!results[0]?.meta.changes) throw fail.notFound('closet.not_found');

  if (rates.perLikeAward > 0 && entry.uploaderId && entry.uploaderId !== actor.id) {
    await env.DB.prepare(`UPDATE users SET score = ${scalarMax('0', 'score - ?')} WHERE id = ?`)
      .bind(rates.perLikeAward, entry.uploaderId).run();
  }
}

// ── 举报 ─────────────────────────────────────────────────────────────────────

export async function submitReport(
  env: SocialEnv,
  reporter: { id: number },
  textureId: number,
  reason: string,
  rates: SocialRates,
): Promise<{ scoreDelta: number }> {
  const database = db(env);
  // 管理员禁用了举报权限的用户不能提交举报（防滥用）
  const [reporterRow] = await database.select({ reportingDisabled: users.reportingDisabled, role: users.role }).from(users).where(eq(users.id, reporter.id)).limit(1);
  if (reporterRow?.reportingDisabled && !isAdminRole(reporterRow.role as Role)) throw fail.forbidden('report.disabled');

  const texture = await textureRepo.findTextureById(database, textureId);
  if (!texture) throw fail.notFound('texture.not_found');
  // 官方材质是站点自有内容，不提供社区举报通道
  if (texture.official) throw fail.forbidden('report.official_disabled');
  // 举报是社区监督机制：拥有者举报自己没有意义，还会空转押金/奖励的积分流动
  if (texture.uploaderId === reporter.id) throw fail.invalid('report.self');

  // 同一举报人对同一纹理存在待处理举报时不能再报；处理完成后可重新举报
  if (await repo.findReportByReporterAndTexture(database, reporter.id, textureId)) {
    throw fail.conflict('report.already_reported');
  }

  // 提交频率：全局每分钟最多 3 条，防止刷举报（pending 去重只限同一纹理）。
  // 计数与插入是两步，PostgreSQL/MySQL 的快照读下并发提交可以少算几条 ——
  // 这里当成软限制：真正防刷的是待处理去重（有唯一索引兜底）与验证码。
  const recent = await database
    .select({ n: sql<number>`count(*)` })
    .from(reports)
    .where(and(eq(reports.reporterId, reporter.id), gt(reports.createdAt, Date.now() - 60_000)));
  if ((recent[0]?.n ?? 0) >= 3) throw new AppError('report.rate_limited', 429);

  // 先占位再动积分：并发重复提交时后到的那条拿不到行（唯一索引兜底），不留积分副作用
  const createdAt = Date.now();
  const inserted = await repo.insertReport(env.DB, {
    textureId,
    // 快照举报时刻的上传者，不随之后变化重算
    uploaderId: texture.uploaderId,
    reporterId: reporter.id,
    reason,
    createdAt,
  });
  if (!inserted) throw fail.conflict('report.already_reported');

  // 举报可以收费也可以奖励，由设置决定。默认 0，即完全惰性。
  // 负数（押金）时先检查余额，不允许把分数扣成负数。
  const delta = rates.reporterScoreDelta;
  if (delta !== 0) {
    if (delta < 0) {
      const charged = await env.DB
        .prepare('UPDATE users SET score = score + ? WHERE id = ? AND score >= ?')
        .bind(delta, reporter.id, -delta)
        .run();
      if ((charged.meta.changes ?? 0) === 0) {
        // 扣分失败就不该留下举报记录；删掉刚占位的那条（条件精确到本次 createdAt）
        await env.DB
          .prepare("DELETE FROM reports WHERE reporter_id = ? AND texture_id = ? AND status = 'pending' AND created_at = ?")
          .bind(reporter.id, textureId, createdAt)
          .run();
        throw fail.insufficientScore();
      }
    } else {
      await env.DB.prepare('UPDATE users SET score = score + ? WHERE id = ?')
        .bind(delta, reporter.id).run();
    }
  }

  return { scoreDelta: delta };
}

export async function listMyReports(env: SocialEnv, reporterId: number) {
  return { items: await repo.listReportsByReporter(db(env), reporterId) };
}

export async function listReportsForReview(env: SocialEnv, status: string) {
  return { items: await repo.listReportsByStatus(db(env), status) };
}

export type ReviewAction = 'delete' | 'ban' | 'reject';

/** 角色层级。与 @pigeon-skin/shared 的 ROLE_RANK 一致，这里只需要比较大小。 */
function rank(role: string): number {
  return role === 'super_admin' ? 2 : role === 'admin' ? 1 : 0;
}

/**
 * 审核举报。
 *
 * 三种动作的副作用各不相同，但都必须先通过角色层级检查：
 * 管理员不能封禁同级或更高级别的用户。
 */
export async function reviewReport(
  env: SocialEnv,
  reviewer: { id: number; role: string },
  reportId: number,
  action: ReviewAction,
  rates: SocialRates,
): Promise<void> {
  const database = db(env);
  const report = await repo.findReportById(database, reportId);
  if (!report) throw fail.notFound('report.not_found');
  if (report.status !== 'pending') throw fail.conflict('report.already_reviewed');

  const now = Date.now();

  if (action === 'ban' && report.uploaderId) {
    // 管理员不能封禁同级或更高级别的用户
    const [target] = await database
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, report.uploaderId))
      .limit(1);
    if (rank(target?.role ?? 'normal') >= rank(reviewer.role)) {
      throw fail.forbidden('admin.cannot_modify_peer');
    }

    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET role = 'banned' WHERE id = ?`).bind(report.uploaderId),
      // 封禁即撤销该用户所有会话 —— 否则被封的人拿着旧 Cookie 还能继续用
      env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
        .bind(now, report.uploaderId),
    ]);
  }

  if (action === 'delete') {
    const texture = await textureRepo.findTextureById(database, report.textureId);
    if (texture) {
      await textureRepo.deleteTexture(database, report.textureId);
      // R2 对象按哈希引用计数才删（多行可能共享同一对象）
      if (await textureRepo.countReferencesToHash(database, texture.hash) === 0) {
        await env.BUCKET.delete(textureObjectKey(texture.hash));
      }
      if (!(await textureRepo.countPublicReferencesToHash(database, texture.hash))) {
        await (await import('./texture-access.ts')).purgeTextureDerivatives(env, texture.hash);
      }
    }
  }

  await repo.markReportReviewed(database, reportId, {
    status: action === 'reject' ? 'rejected' : 'resolved',
    resolution: action,
    reviewerId: reviewer.id,
    reviewedAt: now,
  });
  await audit(env, {
    actorId: reviewer.id, action: 'admin.report.resolve',
    targetType: 'report', targetId: reportId,
    detail: `action:${action},texture:${report.textureId}`,
  });

  // 处理完成要给举报人奖励（旧版的 reporter_reward_score）
  if (rates.reporterReward > 0 && action !== 'reject') {
    await env.DB.prepare(`UPDATE users SET score = score + ? WHERE id = ?`)
      .bind(rates.reporterReward, report.reporterId).run();
  }

  // 审核结果通知举报人。失败不回滚审核本身 —— 通知是附带的，
  // 不能让铃铛故障挡住管理员已经做出的决定。
  try {
    await db(env).insert(notifications).values({
      userId: report.reporterId,
      type: 'report_reviewed',
      title: reportTitle(action),
      body: `texture:${report.textureId}`,
      createdAt: now,
    });
  } catch { /* 通知失败不影响审核结果 */ }
}

/** 举报审核结果的通知标题。与前端 i18n 的 report_reviewed.* 键对应。 */
function reportTitle(action: ReviewAction): string {
  if (action === 'reject') return 'report_reviewed.rejected';
  if (action === 'ban') return 'report_reviewed.upheld_banned';
  return 'report_reviewed.upheld_deleted';
}
