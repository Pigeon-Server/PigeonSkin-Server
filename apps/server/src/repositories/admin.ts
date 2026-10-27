// 后台仓储 —— 只负责查询。
import { and, eq, gt, gte, lt, inArray, or, sql } from 'drizzle-orm';
import { scalarMax, aiJobs, chunkBind, players, textures, users, closet, noCaseEq, siteStats, dailyStats, textureCounts, dialect } from '@pigeon-skin/db';
import type { Db } from './textures.ts';
import type { SQL } from 'drizzle-orm';
import { fragmentToSql, type SqlFragment } from '../search/compile.ts';

/**
 * 搜索条件由 apps/server/src/search 编译成语义片段后传入，仓储只负责嵌入。
 * 空片段（无搜索）返回恒真条件，便于 and() 组装。
 */
function searchFilter(search: SqlFragment | null | undefined): SQL {
  return search ? fragmentToSql(search) : sql`1=1`;
}

/**
 * 把 helper 产出的含 {COL} 列占位与单个 ? 值占位的 SQL 片段嵌入 drizzle 模板：
 * {COL} 换成列引用块，? 处保持值为绑定参数。
 */
function embedFrag(frag: string, column: SQL, value: unknown) {
  const [lhs = '', rhs = ''] = frag.split('{COL}');
  const q = rhs.indexOf('?');
  return sql`${sql.raw(lhs)}${column}${sql.raw(rhs.slice(0, q))}${value}${sql.raw(rhs.slice(q + 1))}`;
}

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

async function daily(
  db: Db,
  daySource: 'users' | 'textures',
): Promise<Array<{ day: string; n: number }>> {
  const since = Date.now() - 31 * 86_400_000;
  const boundary = Math.floor(since / 86_400_000) * 86_400_000;
  const metric = daySource === 'users' ? 'registrations' : 'uploads';
  const rows = await db.select({ day: dailyStats.day, n: dailyStats.value }).from(dailyStats)
    .where(and(eq(dailyStats.metric, metric), gt(dailyStats.day, boundary), gt(dailyStats.value, 0))).orderBy(dailyStats.day);
  const table = daySource === 'users' ? users : textures;
  const [partial] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(table)
    .where(and(gte(table.createdAt, since), lt(table.createdAt, boundary + 86_400_000)));
  return [...(partial?.n ? [{ day: boundary, n: partial.n }] : []), ...rows]
    .map(row => ({ day: new Date(row.day).toISOString().slice(0, 10), n: row.n }));
}

export async function collectStats(db: Db): Promise<AdminStats> {
  const values = Object.fromEntries((await db.select().from(siteStats)).map(row => [row.metric, Number(row.value)]));

  const [registrations, uploads] = await Promise.all([
    daily(db, 'users'),
    daily(db, 'textures'),
  ]);

  return {
    users: values.users ?? 0,
    players: values.players ?? 0,
    textures: values.textures ?? 0,
    pendingReports: values.pending_reports ?? 0,
    storageKb: dialect() === 'mysql' ? (values.texture_bytes ?? 0) / 1024 : Math.floor((values.texture_bytes ?? 0) / 1024),
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
  reportingDisabled: users.reportingDisabled,
  commentsDisabled: users.commentsDisabled,
  createdAt: users.createdAt,
  playerCount: sql<number>`(SELECT COUNT(*) FROM players WHERE user_id = ${users.id})`,
} as const;

export async function listAdminUsers(
  db: Db,
  filter: { search?: SqlFragment | null | undefined },
  page: { perPage: number; offset: number },
) {
  const where = searchFilter(filter.search);

  const [countRow] = filter.search
    ? await db.select({ n: sql<number>`count(*)` }).from(users).where(where)
    : await db.select({ n: siteStats.value }).from(siteStats).where(eq(siteStats.metric, 'users'));
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
    .set({ likes: sql.raw(scalarMax('0', '"textures"."likes" - 1')) })
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

export interface AdminTextureFilter {
  search?: SqlFragment | null | undefined;
  kind?: string | undefined;
  visibility?: string | undefined;
  official?: boolean | undefined;
}

export async function listAdminTextures(
  db: Db,
  filter: AdminTextureFilter,
  page: { perPage: number; offset: number },
) {
  const where = and(
    searchFilter(filter.search),
    filter.kind ? eq(textures.kind, filter.kind) : sql`1=1`,
    filter.visibility ? eq(textures.visibility, filter.visibility) : sql`1=1`,
    filter.official === undefined
      ? sql`1=1`
      : filter.official ? sql`${textures.officialKey} IS NOT NULL` : sql`${textures.officialKey} IS NULL`,
  );

  const countQuery = db.select({ n: sql<number>`count(*)` }).from(textures).$dynamic();
  if (/\busers\b/.test(filter.search?.sql ?? '')) countQuery.leftJoin(users, eq(users.id, textures.uploaderId));
  const [countRow] = filter.search ? await countQuery.where(where)
    : await db.select({ n: sql<number>`COALESCE(SUM(${textureCounts.value}),0)`.mapWith(Number) }).from(textureCounts).where(and(
      inArray(textureCounts.scope, filter.visibility ? [`p:${filter.visibility}`] : ['p:public', 'p:private']),
      filter.kind ? eq(textureCounts.kind, filter.kind) : undefined,
      filter.official === undefined ? undefined : eq(textureCounts.official, filter.official ? 1 : 0),
    ));
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
      official: sql<boolean>`${textures.officialKey} IS NOT NULL`.mapWith(Boolean),
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

// ── 纹理：批量治理 ───────────────────────────────────────────────────────────
//
// 批量动作要求"取一次、改一次、清一次"，逐条调用单条版本会把每条的子请求
// （计数、R2、衍生图、sitemap）乘上批量条数，很快就会撞 Workers 的子请求上限。

export interface AdminTextureRef {
  id: number;
  hash: string;
  visibility: string;
  uploaderId: number | null;
}

export async function findAdminTexturesByIds(db: Db, ids: readonly number[]): Promise<AdminTextureRef[]> {
  const rows: AdminTextureRef[] = [];
  for (const part of chunkBind(ids)) {
    rows.push(...await db.select({
      id: textures.id,
      hash: textures.hash,
      visibility: textures.visibility,
      uploaderId: textures.uploaderId,
    }).from(textures).where(inArray(textures.id, part)));
  }
  return rows;
}

export async function findUserRolesByIds(db: Db, ids: readonly number[]): Promise<Array<{ id: number; role: string }>> {
  const rows: Array<{ id: number; role: string }> = [];
  for (const part of chunkBind(ids)) {
    rows.push(...await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, part)));
  }
  return rows;
}

export async function deleteAdminTextures(db: Db, ids: readonly number[]): Promise<void> {
  for (const part of chunkBind(ids)) await db.delete(textures).where(inArray(textures.id, part));
}

export async function setAdminTexturesVisibility(
  db: Db, ids: readonly number[], visibility: string, updatedAt: number,
): Promise<void> {
  for (const part of chunkBind(ids)) {
    await db.update(textures).set({ visibility, updatedAt }).where(inArray(textures.id, part));
  }
}

/** 删除残留的 AI 任务行（ai_jobs 无外键，不随材质级联） */
export async function deleteAiJobsForTextures(db: Db, ids: readonly number[]): Promise<void> {
  for (const part of chunkBind(ids)) await db.delete(aiJobs).where(inArray(aiJobs.tid, part));
}

/**
 * 穿戴者查询的分片容量。
 *
 * `skin_texture_id = ? OR cape_texture_id = ?` 一条语句要绑 2×N 个参数，
 * 所以只能用通用上限（100）的一半：45×2 + 1（updated_at）= 91 ≤ 100。
 * 用默认的 90 分片在批量删除 50 条以上时会直接撞上限报错。
 */
const WEARING_CHUNK = 45;

/** 谁穿戴着这批纹理 → 角色名（按纹理 id 归组） */
export async function listPlayersWearingTextures(
  db: Db, ids: readonly number[],
): Promise<Map<number, string[]>> {
  const wearing = new Map<number, string[]>();
  for (const part of chunkBind(ids, WEARING_CHUNK)) {
    const rows = await db
      .select({ name: players.name, skinTextureId: players.skinTextureId, capeTextureId: players.capeTextureId })
      .from(players)
      .where(or(inArray(players.skinTextureId, part), inArray(players.capeTextureId, part)));
    for (const row of rows) {
      for (const id of new Set([row.skinTextureId, row.capeTextureId])) {
        if (id === null || !part.includes(id)) continue;
        const names = wearing.get(id) ?? [];
        names.push(row.name);
        wearing.set(id, names);
      }
    }
  }
  return wearing;
}

/**
 * 推进穿戴这批纹理的角色行 `updated_at`。
 *
 * 必须在删除/改写**之前**调用：外键的 ON DELETE SET NULL 会把指针置空，
 * 之后就再也查不到这些角色了，而它们的协议出口内容已经变了。
 */
export async function touchPlayersWearingTextures(
  db: Db, ids: readonly number[], updatedAt: number,
): Promise<void> {
  for (const part of chunkBind(ids, WEARING_CHUNK)) {
    await db.update(players).set({ updatedAt })
      .where(or(inArray(players.skinTextureId, part), inArray(players.capeTextureId, part)));
  }
}


// ── 玩家 ─────────────────────────────────────────────────────────────────────

export async function listAdminPlayers(
  db: Db,
  filter: { search?: SqlFragment | null | undefined },
  page: { perPage: number; offset: number },
) {
  const where = searchFilter(filter.search);

  const countQuery = db.select({ n: sql<number>`count(*)` }).from(players).$dynamic();
  if (/\busers\b/.test(filter.search?.sql ?? '')) countQuery.leftJoin(users, eq(users.id, players.userId));
  const [countRow] = filter.search ? await countQuery.where(where)
    : await db.select({ n: siteStats.value }).from(siteStats).where(eq(siteStats.metric, 'players'));
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
      skinModel: sql<string | null>`(SELECT model FROM textures WHERE id = ${players.skinTextureId})`,
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
  return embedFrag(noCaseEq('{COL}', '?'), sql`${users.email}`, receiver);
}

export async function countRecipients(db: Db, receiver: 'all' | 'normal' | number | string) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(users)
    .where(recipientWhere(receiver));
  return row?.n ?? 0;
}

export async function listBroadcastRecipients(db: Db, receiver: 'all' | 'normal' | number | string) {
  return db.select({ id: users.id, email: users.email, locale: users.locale, score: users.score })
    .from(users).where(and(recipientWhere(receiver), sql`${users.role} != 'banned'`));
}

/** 群发收件人的最新角色名（每人取一个；没有角色的用户不出现在结果里）。
 *  全体群发时收件人可能上万，不能用 IN 列表（SQLite 变量上限），用 join 一次取全。 */
export async function listBroadcastPlayerNames(db: Db, receiver: 'all' | 'normal' | number | string) {
  const rows = await db
    .select({ userId: players.userId, name: players.name })
    .from(players)
    .innerJoin(users, eq(users.id, players.userId))
    .where(and(recipientWhere(receiver), sql`${users.role} != 'banned'`))
    .orderBy(players.id);
  const map = new Map<number, string>();
  for (const row of rows) if (!map.has(row.userId)) map.set(row.userId, row.name);
  return map;
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
    : noCaseEq('email', '?');

  const params: unknown[] = [row.title, row.body, row.createdAt];
  if (isId || isEmail) params.push(receiver);

  return d1.prepare(
    `INSERT INTO notifications (user_id, type, title, body, created_at)
     SELECT id, 'site_message', ?, ?, ? FROM users WHERE ${where}`,
  ).bind(...params);
}
