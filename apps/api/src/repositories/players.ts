// 玩家仓储 —— 只负责查询。
import { and, eq, sql } from 'drizzle-orm';
import { players, textures, users } from '@pigeon-skin/db';
import type { Db } from './textures.ts';

/**
 * 列表投影。皮肤与披风的哈希用子查询取回，避免为了两个可选关联
 * 做两次 leftJoin（同一张表 join 两次会让 SQL 与类型都变复杂）。
 */
const LIST_COLUMNS = {
  id: players.id,
  name: players.name,
  userId: players.userId,
  skinTextureId: players.skinTextureId,
  capeTextureId: players.capeTextureId,
  createdAt: players.createdAt,
  updatedAt: players.updatedAt,
  skinHash: sql<string | null>`(SELECT hash FROM textures WHERE id = ${players.skinTextureId})`,
  skinModel: sql<string | null>`(SELECT model FROM textures WHERE id = ${players.skinTextureId})`,
  capeHash: sql<string | null>`(SELECT hash FROM textures WHERE id = ${players.capeTextureId})`,
} as const;

export async function listPlayersByUser(db: Db, userId: number) {
  return db.select(LIST_COLUMNS).from(players)
    .where(eq(players.userId, userId))
    .orderBy(players.id);
}

export async function listPlayersPaged(
  db: Db,
  filter: { keyword?: string | undefined },
  page: { perPage: number; offset: number },
) {
  const where = filter.keyword
    ? sql`${players.name} LIKE ${'%' + filter.keyword + '%'}`
    : sql`1=1`;

  const [countRow] = await db.select({ n: sql<number>`count(*)` }).from(players).where(where);
  const items = await db
    .select({ ...LIST_COLUMNS, ownerName: users.nickname })
    .from(players)
    .leftJoin(users, eq(users.id, players.userId))
    .where(where)
    .orderBy(players.id)
    .limit(page.perPage)
    .offset(page.offset);

  return { items, total: countRow?.n ?? 0 };
}

export async function findPlayerById(db: Db, id: number) {
  const [row] = await db.select({ ...LIST_COLUMNS, scorePaid: players.scorePaid }).from(players)
    .where(eq(players.id, id)).limit(1);
  return row ?? null;
}

/** 玩家名唯一性不区分大小写 —— 查询也要按 NOCASE，否则会漏判 */
export async function findPlayerByNameInsensitive(
  db: Db,
  name: string,
  excludeId?: number,
) {
  const [row] = await db
    .select({ id: players.id })
    .from(players)
    .where(
      excludeId === undefined
        ? sql`${players.name} = ${name} COLLATE NOCASE`
        : and(sql`${players.name} = ${name} COLLATE NOCASE`, sql`${players.id} <> ${excludeId}`),
    )
    .limit(1);
  return row ?? null;
}

export async function insertPlayer(
  db: Db,
  row: { userId: number; name: string; createdAt: number },
) {
  const [inserted] = await db.insert(players).values({
    userId: row.userId,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  }).returning({ id: players.id });
  return inserted!.id;
}

export async function updatePlayer(
  db: Db,
  id: number,
  patch: {
    name?: string;
    userId?: number;
    skinTextureId?: number | null;
    capeTextureId?: number | null;
  },
) {
  await db.update(players).set({ ...patch, updatedAt: Date.now() })
    .where(eq(players.id, id));
}

export async function deletePlayer(db: Db, id: number) {
  await db.delete(players).where(eq(players.id, id));
}

/** 取纹理的类型与可见性，用于"能否指派"的判定 */
export async function findTextureForAssignment(db: Db, textureId: number) {
  const [row] = await db
    .select({
      id: textures.id,
      kind: textures.kind,
      visibility: textures.visibility,
      uploaderId: textures.uploaderId,
    })
    .from(textures)
    .where(eq(textures.id, textureId))
    .limit(1);
  return row ?? null;
}
