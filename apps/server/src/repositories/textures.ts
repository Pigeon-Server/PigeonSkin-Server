// 纹理仓储 —— 只负责查询，不含业务规则。
//
// 这一层的存在意义：把 SQL 收在一处，service 里就不必出现 Drizzle 的写法细节；
// 想换查询实现（加缓存、换索引）时只需改这里。
import { type Pagination } from './../core/framework.ts';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { closet, textures, textureTranslations, texturesDescription, textureCounts, users, chunkBind } from '@pigeon-skin/db';
import type { TextureKind, TextureVisibility } from '@pigeon-skin/shared';

import { fragmentToSql, type SqlFragment } from '../search/compile.ts';
import type * as schema from '@pigeon-skin/db/schema';

export type Db = DrizzleD1Database<typeof schema>;

/** 译表别名：translatedName 的 SQL 里以 tr 引用 */
const translationTable = alias(textureTranslations, 'tr');

/**
 * 列表用的投影：只取展示需要的字段，避免不小心把敏感列带出去。
 * nameCol 传译文覆盖 SQL 时 name 类型为 string（sql<string>），其余列同原文投影。
 */
const listColumns = (nameCol: typeof textures.name | SQL<string>) => ({
  id: textures.id,
  hash: textures.hash,
  kind: textures.kind,
  model: textures.model,
  name: nameCol,
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
} as const);

const LIST_COLUMNS = listColumns(textures.name);

/** 译文覆盖列：有译文用译文（非空时），否则回退原文。 */
function translatedName(): SQL<string> {
  return sql<string>`COALESCE(NULLIF(${translationTable.name}, ''), ${textures.name})`;
}

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
 * 搜索条件由 apps/server/src/search 把表达式编译成片段后传进来。
 * 仓储不解释表达式语法，只把片段嵌进查询 —— 语法与表结构各归其位。
 */
function searchFilter(search: SqlFragment | null | undefined): SQL {
  return search ? fragmentToSql(search) : sql`1=1`;
}

export interface ListTexturesParams {
  kind?: TextureKind | undefined;
  model?: 'default' | 'slim' | undefined;
  uploader?: number | undefined;
  /** 已编译的搜索表达式 */
  search?: SqlFragment | null | undefined;
  sort: 'created' | 'likes';
  official?: boolean | undefined;
  mine?: number | undefined;      // 仅看该用户的
  /** 请求语言：传入时 name 用 texture_translations 覆盖 */
  locale?: string | undefined;
  viewer: { id: number; role: string } | null;
  isAdmin: boolean;
}

function translationJoin(locale: string) {
  return and(eq(translationTable.tid, textures.id), eq(translationTable.locale, locale));
}

export async function listTextures(db: Db, params: ListTexturesParams, page: Pagination, locale?: string) {
  const where = and(
    visibilityScope(params.viewer, params.isAdmin),
    params.kind ? eq(textures.kind, params.kind) : sql`1=1`,
    params.official ? sql`${textures.officialKey} IS NOT NULL` : sql`1=1`,
    params.model ? eq(textures.model, params.model) : sql`1=1`,
    params.uploader ? eq(textures.uploaderId, params.uploader) : sql`1=1`,
    params.mine !== undefined ? eq(textures.uploaderId, params.mine) : sql`1=1`,
    searchFilter(params.search),
  );

  const needsUsers = /\busers\b/.test(params.search?.sql ?? '');
  const countQuery = db.select({ n: sql<number>`count(*)` }).from(textures).$dynamic();
  if (needsUsers) countQuery.leftJoin(users, eq(users.id, textures.uploaderId));
  const total = params.search ? (await countQuery.where(where))[0]?.n ?? 0 : await countTextureGroups(db, params);

  const ordering = [params.sort === 'likes' ? desc(textures.likes) : desc(textures.createdAt), desc(textures.id)];
  const idQuery = db.select({ id: textures.id }).from(textures).$dynamic();
  if (needsUsers) idQuery.leftJoin(users, eq(users.id, textures.uploaderId));
  const selected = await idQuery.where(where).orderBy(...ordering).limit(page.perPage).offset(page.offset);
  if (!selected.length) return { items: [], total };

  const columns = locale ? listColumns(translatedName()) : LIST_COLUMNS;
  const itemQuery = db
    .select(columns)
    .from(textures)
    .leftJoin(users, eq(users.id, textures.uploaderId)).$dynamic();
  if (locale) itemQuery.leftJoin(translationTable, translationJoin(locale));
  const byId = new Map((await itemQuery.where(inArray(textures.id, selected.map(row => row.id))))
    .filter(row => row.visibility === 'public' || params.isAdmin || params.viewer?.id === row.uploaderId)
    .map(row => [row.id, row]));
  const items = selected.flatMap(row => byId.has(row.id) ? [byId.get(row.id)!] : []);

  return { items, total };
}

export async function countTextureGroups(db: Db, params: Pick<ListTexturesParams, 'viewer' | 'isAdmin' | 'uploader' | 'mine' | 'kind' | 'model' | 'official'>): Promise<number> {
  if (params.mine !== undefined && params.uploader !== undefined && params.mine !== params.uploader) return 0;
  const owner = params.mine ?? params.uploader;
  const scopes = owner !== undefined
    ? [`u:${owner}:public`, ...(params.isAdmin || params.viewer?.id === owner ? [`u:${owner}:private`] : [])]
    : params.isAdmin ? ['p:public', 'p:private'] : ['p:public', ...(params.viewer ? [`u:${params.viewer.id}:private`] : [])];
  const [row] = await db.select({ n: sql<number>`COALESCE(SUM(${textureCounts.value}),0)`.mapWith(Number) }).from(textureCounts).where(and(
    inArray(textureCounts.scope, scopes),
    params.kind ? eq(textureCounts.kind, params.kind) : undefined,
    params.model ? eq(textureCounts.model, params.model) : undefined,
    params.official ? eq(textureCounts.official, 1) : undefined,
  ));
  return row?.n ?? 0;
}

export async function findTextureById(db: Db, id: number, locale?: string) {
  const columns = locale ? listColumns(translatedName()) : LIST_COLUMNS;
  const query = db
    .select({
      ...columns,
      updatedAt: textures.updatedAt,
      scoreRefundBasis: textures.scoreRefundBasis,
      scoreAward: textures.scoreAward,
    })
    .from(textures)
    .leftJoin(users, eq(users.id, textures.uploaderId)).$dynamic();
  if (locale) query.leftJoin(translationTable, translationJoin(locale));
  const [row] = await query.where(eq(textures.id, id)).limit(1);
  return row ?? null;
}

/** 重复检测用的精简投影 */
export async function findVisibleDuplicate(
  db: Db,
  hash: string,
  viewerId: number,
  uploadVisibility: TextureVisibility,
  kind?: TextureKind,
  // 模型不再参与定域:它由像素唯一决定,同 hash 必同 model。
  // 保留参数只为调用侧签名兼容(存量行 model 可能为 NULL,按值比较会漏配)。
  _model?: string | null,
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
    sql`(${textures.visibility} = 'public' OR EXISTS (SELECT 1 FROM players p JOIN users u ON u.id = p.user_id WHERE u.role != 'banned' AND (p.skin_texture_id = ${textures.id} OR p.cape_texture_id = ${textures.id})))`,
  ));
  return row?.n ?? 0;
}

/**
 * 批量引用计数。
 *
 * 与单条版的差别不只是省查询：批量删除时必须用同一时刻的计数结果，逐条
 * `countReferencesToHash` 会在删掉本批其他行之前就得出结论，把互相共享同一
 * R2 对象的行判成"无引用"而误删对象。返回的 Map 覆盖传入的全部哈希，未命中的记为 0。
 */
export async function countReferencesToHashes(db: Db, hashes: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>(hashes.map(hash => [hash, 0]));
  for (const part of chunkBind(hashes)) {
    const rows = await db
      .select({ hash: textures.hash, n: sql<number>`count(*)` })
      .from(textures)
      .where(inArray(textures.hash, part))
      .groupBy(textures.hash);
    for (const row of rows) counts.set(row.hash, row.n);
  }
  return counts;
}

export async function countPublicReferencesToHashes(db: Db, hashes: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>(hashes.map(hash => [hash, 0]));
  for (const part of chunkBind(hashes)) {
    const rows = await db
      .select({ hash: textures.hash, n: sql<number>`count(*)` })
      .from(textures)
      .where(and(
        inArray(textures.hash, part),
        sql`(${textures.visibility} = 'public' OR EXISTS (SELECT 1 FROM players p JOIN users u ON u.id = p.user_id WHERE u.role != 'banned' AND (p.skin_texture_id = ${textures.id} OR p.cape_texture_id = ${textures.id})))`,
      ))
      .groupBy(textures.hash);
    for (const row of rows) counts.set(row.hash, row.n);
  }
  return counts;
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
