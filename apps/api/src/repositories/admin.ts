// 后台仓储 —— 只负责查询。
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { and, eq, sql } from 'drizzle-orm';
import { players, reports, textures, users, closet } from '@pigeon-skin/db';
import type { Db } from './textures.ts';

// ── 统计 ─────────────────────────────────────────────────────────────────────

export interface AdminStats {
  users: number;
  players: number;
  textures: number;
  pendingReports: number;
  storageKb: number;
  registrations: Array<{ day: string; n: number }>;
  uploads: Array<{ day: string; n: number }>;
}

/**
 * 近 31 天每日计数。
 *
 * 用 Drizzle 的列引用构造，而不是把表名拼进 SQL 字符串 —— 表名一旦以字符串
 * 形式进入查询，后续任何"把参数传得更宽一点"的改动都会变成注入面。
 * 这里 daySource 是编译期受限的联合类型，但让代码结构本身排除该风险
 * 比让每个读者去验证那个三元表达式更可靠。
 *
 * 注意按表达式排序而不是按别名：SQLite 的 ORDER BY 虽然接受别名，
 * 但 Drizzle 的 orderBy 解析不到 SELECT 里的别名（会报 no such column: day）。
 */
async function daily(
  db: Db,
  daySource: 'users' | 'textures',
): Promise<Array<{ day: string; n: number }>> {
  const since = Date.now() - 31 * 86_400_000;

  if (daySource === 'users') {
    const day = sql<string>`date(${users.createdAt} / 1000, 'unixepoch')`;
    return db
      .select({ day, n: sql<number>`count(*)` })
      .from(users)
      .where(sql`${users.createdAt} >= ${since}`)
      .groupBy(day)
      .orderBy(day);
  }

  const day = sql<string>`date(${textures.createdAt} / 1000, 'unixepoch')`;
  return db
    .select({ day, n: sql<number>`count(*)` })
    .from(textures)
    .where(sql`${textures.createdAt} >= ${since}`)
    .groupBy(day)
    .orderBy(day);
}

export async function collectStats(db: Db): Promise<AdminStats> {
  // 分别计数而不是拼成一条大 SELECT：Drizzle 对 "select 常量 from (子查询)"
  // 这类构造支持有限，而这几条各自命中索引或全表计数，成本可以忽略。
  const [userRows, playerRows, textureRows, pendingRows, storageRows] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(users),
    db.select({ n: sql<number>`count(*)` }).from(players),
    db.select({ n: sql<number>`count(*)` }).from(textures),
    db.select({ n: sql<number>`count(*)` }).from(reports).where(sql`${reports.status} = 'pending'`),
    // size_bytes 是字节，除以 1024 得到 KB。旧库这一列直接存 KB，
    // 新 schema 改存字节以便精确计算计费。
    db.select({ n: sql<number>`COALESCE(SUM(${textures.sizeBytes}), 0) / 1024` }).from(textures),
  ]);

  const [registrations, uploads] = await Promise.all([
    daily(db, 'users'),
    daily(db, 'textures'),
  ]);

  return {
    users: userRows[0]?.n ?? 0,
    players: playerRows[0]?.n ?? 0,
    textures: textureRows[0]?.n ?? 0,
    pendingReports: pendingRows[0]?.n ?? 0,
    storageKb: storageRows[0]?.n ?? 0,
    registrations,
    uploads,
  };
}

// ── 用户 ─────────────────────────────────────────────────────────────────────

const USER_COLUMNS = {
  id: users.id,
  email: users.email,
  nickname: users.nickname,
  role: users.role,
  score: users.score,
  emailVerifiedAt: users.emailVerifiedAt,
  createdAt: users.createdAt,
  playerCount: sql<number>`(SELECT COUNT(*) FROM players WHERE user_id = ${users.id})`,
} as const;

export async function listAdminUsers(
  db: Db,
  filter: { keyword?: string | undefined },
  page: { perPage: number; offset: number },
) {
  const where = filter.keyword
    ? sql`(${users.email} LIKE ${'%' + filter.keyword + '%'}
           OR ${users.nickname} LIKE ${'%' + filter.keyword + '%'})`
    : sql`1=1`;

  const [countRow] = await db.select({ n: sql<number>`count(*)` }).from(users).where(where);
  const items = await db.select(USER_COLUMNS).from(users).where(where)
    .orderBy(users.id).limit(page.perPage).offset(page.offset);

  return { items, total: countRow?.n ?? 0 };
}

export async function findUserRole(db: Db, id: number) {
  const [row] = await db.select({ id: users.id, role: users.role, email: users.email })
    .from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

// ── 收藏（后台视角）────────────────────────────────────────────────────────

/**
 * 列出某用户的收藏。后台用途是排查与清理（如被封号的库存），
 * 所以带 texture 名称与哈希，方便管理员核对要删的是什么。
 */
export async function listUserCloset(
  db: Db,
  userId: number,
  page: { perPage: number; offset: number },
) {
  const [countRow] = await db.select({ n: sql<number>`count(*)` })
    .from(closet).where(eq(closet.userId, userId));
  const items = await db
    .select({
      textureId: closet.textureId,
      itemName: closet.itemName,
      createdAt: closet.createdAt,
      textureName: textures.name,
      hash: textures.hash,
      kind: textures.kind,
      visibility: textures.visibility,
    })
    .from(closet)
    .innerJoin(textures, eq(textures.id, closet.textureId))
    .where(eq(closet.userId, userId))
    .orderBy(sql`${closet.createdAt} DESC`)
    .limit(page.perPage)
    .offset(page.offset);

  return { items, total: countRow?.n ?? 0 };
}

/**
 * 管理员删除用户的收藏行。likes 计数用 MAX(0, …) 兜底，
 * 与 services/social.ts 的用户自助删除保持同一语义（迁移库的 likes 可能偏高）。
 */
export async function adminDeleteClosetEntry(db: Db, userId: number, textureId: number) {
  const deleted = await db.delete(closet)
    .where(sql`${closet.userId} = ${userId} AND ${closet.textureId} = ${textureId}`)
    .returning({ textureId: closet.textureId });
  if (deleted.length === 0) return null;
  await db.update(textures)
    .set({ likes: sql`MAX(0, ${textures.likes} - 1)` })
    .where(eq(textures.id, textureId));
  return deleted[0]!;
}

export async function updateUser(db: Db, id: number, patch: Record<string, unknown>) {
  await db.update(users).set(patch).where(eq(users.id, id));
}

export async function deleteUser(db: Db, id: number) {
  await db.delete(users).where(eq(users.id, id));
}

// ── 纹理 ─────────────────────────────────────────────────────────────────────

export async function listAdminTextures(
  db: Db,
  filter: { keyword?: string | undefined },
  page: { perPage: number; offset: number },
) {
  const where = filter.keyword
    ? sql`${textures.name} LIKE ${'%' + filter.keyword + '%'}`
    : sql`1=1`;

  const [countRow] = await db.select({ n: sql<number>`count(*)` }).from(textures).where(where);
  const items = await db
    .select({
      id: textures.id,
      hash: textures.hash,
      name: textures.name,
      kind: textures.kind,
      model: textures.model,
      visibility: textures.visibility,
      sizeBytes: textures.sizeBytes,
      likes: textures.likes,
      uploaderId: textures.uploaderId,
      uploaderName: users.nickname,
      createdAt: textures.createdAt,
    })
    .from(textures)
    .leftJoin(users, eq(users.id, textures.uploaderId))
    .where(where)
    .orderBy(sql`${textures.id} DESC`)
    .limit(page.perPage)
    .offset(page.offset);

  return { items, total: countRow?.n ?? 0 };
}

// ── 玩家 ─────────────────────────────────────────────────────────────────────

export async function listAdminPlayers(
  db: Db,
  filter: { keyword?: string | undefined },
  page: { perPage: number; offset: number },
) {
  const where = filter.keyword
    ? sql`${players.name} LIKE ${'%' + filter.keyword + '%'}`
    : sql`1=1`;

  const [countRow] = await db.select({ n: sql<number>`count(*)` }).from(players).where(where);
  const items = await db
    .select({
      id: players.id,
      name: players.name,
      userId: players.userId,
      ownerId: players.userId,
      skinTextureId: players.skinTextureId,
      capeTextureId: players.capeTextureId,
      ownerName: users.nickname,
      updatedAt: players.updatedAt,
      skinHash: sql<string | null>`(SELECT hash FROM textures WHERE id = ${players.skinTextureId})`,
      capeHash: sql<string | null>`(SELECT hash FROM textures WHERE id = ${players.capeTextureId})`,
    })
    .from(players)
    .leftJoin(users, eq(users.id, players.userId))
    .where(where)
    .orderBy(players.id)
    .limit(page.perPage)
    .offset(page.offset);

  return { items, total: countRow?.n ?? 0 };
}

export async function findAnyPlayer(db: Db, id: number) {
  const [row] = await db.select({ id: players.id, userId: players.userId, name: players.name, ownerRole: users.role, skinTextureId: players.skinTextureId, capeTextureId: players.capeTextureId })
    .from(players).innerJoin(users, eq(users.id, players.userId)).where(eq(players.id, id)).limit(1);
  return row ?? null;
}

export async function updateAnyPlayer(db: Db, id: number, patch: Record<string, unknown>) {
  await db.update(players).set({ ...patch, updatedAt: Date.now() }).where(eq(players.id, id));
}

export async function deleteAnyPlayer(db: Db, id: number) {
  await db.delete(players).where(eq(players.id, id));
}

// ── 群发通知 ─────────────────────────────────────────────────────────────────

/** 收件人选择：全体 / 普通用户 / 单个 uid / 单个邮箱 */
export function recipientWhere(receiver: 'all' | 'normal' | number | string) {
  if (receiver === 'all') return sql`1=1`;
  if (receiver === 'normal') return sql`${users.role} = 'normal'`;
  if (typeof receiver === 'number') return eq(users.id, receiver);
  return sql`${users.email} = ${receiver} COLLATE NOCASE`;
}

export async function countRecipients(db: Db, receiver: 'all' | 'normal' | number | string) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(users)
    .where(recipientWhere(receiver));
  return row?.n ?? 0;
}

export async function listBroadcastRecipients(db: Db, receiver: 'all' | 'normal' | number | string) {
  return db.select({ id: users.id, email: users.email, locale: users.locale })
    .from(users).where(and(recipientWhere(receiver), sql`${users.role} != 'banned'`));
}

/**
 * 群发的 INSERT…SELECT 语句：一条语句写给全部收件人，避免 N 次往返。
 *
 * 用原生语句而不是 Drizzle 的 insert，因为 Drizzle 对 insert…select 的支持有限，
 * 而这里需要的正是"从 users 选出 id 再插入 notifications"。
 */
export function broadcastStatement(
  d1: { prepare: (sql: string) => D1PreparedStatement },
  receiver: 'all' | 'normal' | number | string,
  row: { title: string; body: string; createdAt: number },
) {
  const isId = typeof receiver === 'number';
  const isEmail = typeof receiver === 'string' && receiver !== 'all' && receiver !== 'normal';

  const where = receiver === 'all' ? '1=1'
    : receiver === 'normal' ? "role = 'normal'"
    : isId ? 'id = ?'
    : 'email = ? COLLATE NOCASE';

  const params: unknown[] = [row.title, row.body, row.createdAt];
  if (isId || isEmail) params.push(receiver);

  return d1.prepare(
    `INSERT INTO notifications (user_id, type, title, body, created_at)
     SELECT id, 'site_message', ?, ?, ? FROM users WHERE ${where}`,
  ).bind(...params);
}
