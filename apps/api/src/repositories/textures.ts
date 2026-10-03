// 纹理仓储 —— 只负责查询，不含业务规则。
//
// 这一层的存在意义：把 SQL 收在一处，service 里就不必出现 Drizzle 的写法细节；
// 想换查询实现（加缓存、换索引）时只需改这里。
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { closet, textures, texturesDescription, users } from '@pigeon-skin/db';
import type { TextureKind, TextureVisibility } from '@pigeon-skin/shared';
import type { Pagination } from '../framework.ts';
import type * as schema from '@pigeon-skin/db/schema';

export type Db = DrizzleD1Database<typeof schema>;

/** 列表用的投影：只取展示需要的字段，避免不小心把敏感列带出去 */
const LIST_COLUMNS = {
  id: textures.id,
  hash: textures.hash,
  kind: textures.kind,
  model: textures.model,
  name: textures.name,
  official: sql<boolean>`${textures.officialKey} IS NOT NULL`.mapWith(Boolean),
  visibility: textures.visibility,
  width: textures.width,
  height: textures.height,
  sizeBytes: textures.sizeBytes,
  likes: textures.likes,
  uploaderId: textures.uploaderId,
  uploaderName: users.nickname,
  sourceResourceId: textures.sourceResourceId,
  origin: textures.origin,
  sourceResourceName: sql<string | null>`(SELECT source.name FROM textures AS source WHERE source.id = ${textures.sourceResourceId})`,
  createdAt: textures.createdAt,
} as const;

/**
 * 可见性范围。
 *
 * 必须在 **SQL 里**强制，而不是取回来再过滤 —— 否则分页的 total 会把
 * 无权查看的行也算进去，前端看到的"共 N 条"和实际能翻的页数对不上。
 */
function visibilityScope(
  viewer: { id: number; role: string } | null,
  isAdmin: boolean,
): SQL {
  if (isAdmin) return sql`1=1`;
  if (viewer) {
    return sql`(${textures.visibility} = 'public' OR ${textures.uploaderId} = ${viewer.id})`;
  }
  return sql`${textures.visibility} = 'public'`;
}

/**
 * 关键词过滤。
 *
 * FTS5 的 trigram 分词器要求查询至少 3 个字符（以 3 字符为单位建索引），
 * 更短的查询命中不了 MATCH。中文用户很自然会输入两个字，所以短查询
 * 必须回退到 LIKE —— 这条限制在 packages/db 的测试里被显式锁住了。
 */
function keywordFilter(keyword: string): SQL {
  if (keyword.length === 0) return sql`1=1`;
  if (keyword.length >= 3) {
    const phrase = `"${keyword.replaceAll('"', '""')}"`;
    return sql`${textures.id} IN (SELECT rowid FROM textures_fts WHERE textures_fts MATCH ${phrase})`;
  }
  return sql`${textures.name} LIKE ${'%' + keyword + '%'}`;
}

export interface ListTexturesParams {
  kind?: TextureKind | undefined;
  model?: 'default' | 'slim' | undefined;
  uploader?: number | undefined;
  keyword?: string | undefined;
  sort: 'created' | 'likes';
  official?: boolean | undefined;
  mine?: number | undefined;      // 仅看该用户的
  viewer: { id: number; role: string } | null;
  isAdmin: boolean;
}

export async function listTextures(db: Db, params: ListTexturesParams, page: Pagination) {
  const where = and(
    visibilityScope(params.viewer, params.isAdmin),
    params.kind ? eq(textures.kind, params.kind) : sql`1=1`,
    params.official ? sql`${textures.officialKey} IS NOT NULL` : sql`1=1`,
    params.model ? eq(textures.model, params.model) : sql`1=1`,
    params.uploader ? eq(textures.uploaderId, params.uploader) : sql`1=1`,
    params.mine !== undefined ? eq(textures.uploaderId, params.mine) : sql`1=1`,
    keywordFilter(params.keyword ?? ''),
  );

  const [countRow] = await db.select({ n: sql<number>`count(*)` }).from(textures).where(where);

  const items = await db
    .select(LIST_COLUMNS)
    .from(textures)
    .leftJoin(users, eq(users.id, textures.uploaderId))
    .where(where)
    .orderBy(
      params.sort === 'likes'
        ? desc(textures.likes)
        : desc(textures.createdAt),
      desc(textures.id),
    )
    .limit(page.perPage)
    .offset(page.offset);

  return { items, total: countRow?.n ?? 0 };
}

export async function findTextureById(db: Db, id: number) {
  const [row] = await db
    .select({
      ...LIST_COLUMNS,
      updatedAt: textures.updatedAt,
      scoreRefundBasis: textures.scoreRefundBasis,
      scoreAward: textures.scoreAward,
    })
    .from(textures)
    .leftJoin(users, eq(users.id, textures.uploaderId))
    .where(eq(textures.id, id))
    .limit(1);
  return row ?? null;
}

/** 重复检测用的精简投影 */
export async function findVisibleDuplicate(
  db: Db,
  hash: string,
  viewerId: number,
  uploadVisibility: TextureVisibility,
  kind?: TextureKind,
  model?: string | null,
) {
  const duplicateScope = uploadVisibility === 'private'
    ? or(eq(textures.visibility, 'public'), eq(textures.uploaderId, viewerId))
    : eq(textures.visibility, 'public');
  const [row] = await db
    .select({ id: textures.id })
    .from(textures)
    .where(
      and(
        eq(textures.hash, hash),
        ...(kind ? [eq(textures.kind, kind)] : []),
        ...(kind === 'skin' ? [sql`${textures.model} IS ${model ?? 'default'}`] : []),
        // 公共作品不能重复发布；私有作品只阻止所有者再次保存为私有。
        duplicateScope,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertTextureRow(
  db: Db,
  row: {
    hash: string; kind: TextureKind; model: string | null; name: string;
    uploaderId: number; sizeBytes: number; visibility: TextureVisibility; origin?: 'original' | 'repost';
    width: number; height: number; createdAt: number; sourceResourceId?: number | null;
  },
  description?: string,
) {
  const insertion = db.insert(textures).values({
    ...row,
    likes: 1,                    // 上传时自动加入自己的收藏，所以初始为 1
    updatedAt: row.createdAt,
  }).returning({ id: textures.id });
  const [inserted] = description
    ? (await db.batch([insertion, db.insert(texturesDescription).values({ tid: sql`last_insert_rowid()`, description, updatedAt: row.createdAt })]))[0]
    : await insertion;
  return inserted!.id;
}

export async function addToOwnCloset(db: Db, userId: number, textureId: number, name: string) {
  await db.insert(closet)
    .values({ userId, textureId, itemName: name, createdAt: Date.now() })
    .onConflictDoNothing();
}

export async function updateTexture(
  db: Db,
  id: number,
  patch: { name?: string; visibility?: TextureVisibility; hash?: string; width?: number; height?: number; sizeBytes?: number; updatedAt: number },
) {
  await db.update(textures).set(patch).where(eq(textures.id, id));
}

export async function deleteTexture(db: Db, id: number) {
  await db.delete(textures).where(eq(textures.id, id));
}

/**
 * 还有多少行引用这个哈希。
 *
 * 因为 hash 有意不加唯一约束（旧库允许多行共享同一对象），删除 R2 对象前
 * 必须计数 —— 直接删会让其他玩家的皮肤一起坏掉。
 */
export async function countReferencesToHash(db: Db, hash: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(textures)
    .where(eq(textures.hash, hash));
  return row?.n ?? 0;
}

export async function countPublicReferencesToHash(db: Db, hash: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(textures).where(and(
    eq(textures.hash, hash),
    sql`${textures.visibility} = 'public' OR EXISTS (SELECT 1 FROM players p JOIN users u ON u.id = p.user_id WHERE u.role != 'banned' AND (p.skin_texture_id = ${textures.id} OR p.cape_texture_id = ${textures.id}))`,
  ));
  return row?.n ?? 0;
}

export async function findPlayerEquippedTextures(db: Db, textureId: number) {
  // 用于删除后清理引用（外键的 ON DELETE SET NULL 已经处理，这里只是留一个
  // 显式的查询点，便于将来加"删除前提示会影响哪些玩家"）
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(textures)
    .where(and(eq(textures.id, textureId), isNull(textures.uploaderId)));
  return row?.n ?? 0;
}
