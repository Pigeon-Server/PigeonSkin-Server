// 收藏与举报仓储。
import { and, eq, sql } from 'drizzle-orm';
import { closet, reports, textures, users } from '@pigeon-skin/db';
import type { Db } from './textures.ts';

// ── 收藏 ─────────────────────────────────────────────────────────────────────

export async function listCloset(
  db: Db,
  userId: number,
  filter: { category?: string | undefined; keyword?: string | undefined; page?: number | undefined; perPage?: number | undefined },
) {
  const where = and(
    eq(closet.userId, userId),
    filter.category ? eq(textures.kind, filter.category) : sql`1=1`,
    filter.keyword ? sql`${textures.name} LIKE ${'%' + filter.keyword + '%'}` : sql`1=1`,
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

export async function findReportByReporterAndTexture(db: Db, reporterId: number, textureId: number) {
  const [row] = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.reporterId, reporterId), eq(reports.textureId, textureId)))
    .limit(1);
  return row ?? null;
}

export async function insertReport(
  db: Db,
  row: { textureId: number; uploaderId: number | null; reporterId: number; reason: string; createdAt: number },
) {
  await db.insert(reports).values({ ...row, status: 'pending' });
}

export async function markReportReviewed(
  db: Db,
  id: number,
  row: { status: 'resolved' | 'rejected'; resolution: string; reviewerId: number; reviewedAt: number },
) {
  await db.update(reports).set(row).where(eq(reports.id, id));
}
