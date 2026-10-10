// 收藏与举报仓储。
import { and, eq, sql } from 'drizzle-orm';
import { closet, isLockConflict, isUniqueViolation, reports, textures, users } from '@pigeon-skin/db';
import type { Db } from './textures.ts';
import { fragmentToSql, type SqlFragment } from '../search/compile.ts';

// ── 收藏 ─────────────────────────────────────────────────────────────────────

export async function listCloset(
  db: Db,
  userId: number,
  filter: { category?: string | undefined; search?: SqlFragment | null | undefined; page?: number | undefined; perPage?: number | undefined },
) {
  const where = and(
    eq(closet.userId, userId),
    filter.category ? eq(textures.kind, filter.category) : sql`1=1`,
    filter.search ? fragmentToSql(filter.search) : sql`1=1`,
  );

  const perPage = filter.perPage || 24;
  const page = filter.page || 1;
  const rows = await db
    .select({
      textureId: closet.textureId,
      itemName: closet.itemName,
      createdAt: closet.createdAt,
      hash: textures.hash,
      kind: textures.kind,
      model: textures.model,
      textureName: textures.name,
      visibility: textures.visibility,
    })
    .from(closet)
    .innerJoin(textures, eq(textures.id, closet.textureId))
    .where(where)
    .orderBy(sql`${closet.createdAt} DESC`)
    .limit(perPage + 1)
    .offset((page - 1) * perPage);

  // displayName 的回落规则属于展示逻辑，但放在这里可以让所有调用方一致
  const hasMore = rows.length > perPage;
  return { items: rows.slice(0, perPage).map((r) => ({ ...r, displayName: r.itemName ?? r.textureName })), page, hasMore };
}

export async function findClosetEntry(db: Db, userId: number, textureId: number) {
  const [row] = await db
    .select({ textureId: closet.textureId })
    .from(closet)
    .where(and(eq(closet.userId, userId), eq(closet.textureId, textureId)))
    .limit(1);
  return row ?? null;
}

/** 删除收藏并返回被删纹理的上传者（用于扣回奖励） */
export async function deleteClosetEntry(db: Db, userId: number, textureId: number) {
  const [row] = await db
    .select({ uploaderId: textures.uploaderId, isDefault: closet.isDefault })
    .from(closet)
    .innerJoin(textures, eq(textures.id, closet.textureId))
    .where(and(eq(closet.userId, userId), eq(closet.textureId, textureId)))
    .limit(1);
  return row ?? null;
}

export async function renameClosetEntry(db: Db, userId: number, textureId: number, name: string | null) {
  const updated = await db
    .update(closet)
    .set({ itemName: name })
    .where(and(eq(closet.userId, userId), eq(closet.textureId, textureId)))
    .returning({ textureId: closet.textureId });
  return updated.length > 0;
}

// ── 举报 ─────────────────────────────────────────────────────────────────────

export async function listReportsByReporter(db: Db, reporterId: number) {
  return db
    .select({
      id: reports.id,
      textureId: reports.textureId,
      textureName: textures.name,
      reason: reports.reason,
      status: reports.status,
      resolution: reports.resolution,
      createdAt: reports.createdAt,
      reviewedAt: reports.reviewedAt,
    })
    .from(reports)
    .leftJoin(textures, eq(textures.id, reports.textureId))
    .where(eq(reports.reporterId, reporterId))
    .orderBy(sql`${reports.createdAt} DESC`);
}

export async function listReportsByStatus(db: Db, status: string) {
  return db
    .select({
      id: reports.id,
      textureId: reports.textureId,
      textureName: textures.name,
      textureHash: textures.hash,
      reason: reports.reason,
      status: reports.status,
      uploaderId: reports.uploaderId,
      uploaderName: users.nickname,
      reporterId: reports.reporterId,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .leftJoin(textures, eq(textures.id, reports.textureId))
    .leftJoin(users, eq(users.id, reports.uploaderId))
    .where(eq(reports.status, status))
    .orderBy(sql`${reports.createdAt} ASC`);
}

export async function findReportById(db: Db, id: number) {
  const [row] = await db
    .select({
      id: reports.id,
      textureId: reports.textureId,
      uploaderId: reports.uploaderId,
      reporterId: reports.reporterId,
      status: reports.status,
    })
    .from(reports)
    .where(eq(reports.id, id))
    .limit(1);
  return row ?? null;
}

/** 查找举报人未处理完的举报；已 resolved/rejected 的历史举报不阻止再次举报 */
export async function findReportByReporterAndTexture(db: Db, reporterId: number, textureId: number) {
  const [row] = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.reporterId, reporterId), eq(reports.textureId, textureId), eq(reports.status, 'pending')))
    .limit(1);
  return row ?? null;
}

/**
 * 插入一条待处理举报：同一举报人对同一纹理已有 pending 举报时不写入。
 * 返回 true 表示真的插入成功，false 表示已有 pending（含并发抢先的情况）。
 *
 * 条件插入（WHERE NOT EXISTS）负责常规路径，但它在 PostgreSQL/MySQL 的
 * 快照读下并不原子 —— 并发请求可能同时认为"没有 pending"。真正的保证是
 * 0027 的部分唯一索引 reports_pending_unique（MySQL 为表达式唯一索引）：
 * 后者让第二个写入者收到唯一冲突，这里把冲突映射成同一业务结果。
 * `FROM (SELECT 1) AS src` 是 MySQL 的硬性要求（无 FROM 的 SELECT 不允许带 WHERE）。
 */
export async function insertReport(
  d1: D1Database,
  row: { textureId: number; uploaderId: number | null; reporterId: number; reason: string; createdAt: number },
): Promise<boolean> {
  const bind = () => [row.textureId, row.uploaderId, row.reporterId, row.reason, row.createdAt, row.reporterId, row.textureId];
  const statement = `INSERT INTO reports (texture_id, uploader_id, reporter_id, reason, status, created_at)
         SELECT ?, ?, ?, ?, 'pending', ?
         FROM (SELECT 1) AS src
         WHERE NOT EXISTS (SELECT 1 FROM reports WHERE reporter_id = ? AND texture_id = ? AND status = 'pending')`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await d1.prepare(statement).bind(...bind()).run();
      return (result.meta.changes ?? 0) > 0;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      // MySQL 在 REPEATABLE READ 下并发条件插入可能因间隙锁死锁（实测 60 并发出现数次），
      // 被回滚的一方重试一次就能看到对方的结果，不需要让用户看到 500
      if (attempt === 1 && isLockConflict(error)) continue;
      throw error;
    }
  }
}

export async function markReportReviewed(
  db: Db,
  id: number,
  row: { status: 'resolved' | 'rejected'; resolution: string; reviewerId: number; reviewedAt: number },
) {
  await db.update(reports).set(row).where(eq(reports.id, id));
}
