// 用户资料与积分仓储。
import { and, eq, sql } from 'drizzle-orm';
import { players, textures, users, noCaseEq } from '@pigeon-skin/db';
import type { Db } from './textures.ts';
import type { SQL } from 'drizzle-orm';

/** 把 helper 产出的含 {COL} 列占位与单个 ? 值占位的 SQL 片段嵌入 drizzle 模板。 */
function embedFrag(frag: string, column: SQL, value: unknown) {
  const [lhs = '', rhs = ''] = frag.split('{COL}');
  const q = rhs.indexOf('?');
  return sql`${sql.raw(lhs)}${column}${sql.raw(rhs.slice(0, q))}${value}${sql.raw(rhs.slice(q + 1))}`;
}

export async function findUserProfile(db: Db, id: number) {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      nickname: users.nickname,
      locale: users.locale,
      score: users.score,
      avatarTextureId: users.avatarTextureId,
      isDarkMode: users.isDarkMode,
      role: users.role,
      emailVerifiedAt: users.emailVerifiedAt,
      lastSignAt: users.lastSignAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
}

export async function findUserCredentials(db: Db, id: number) {
  const [row] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, email: users.email, nickname: users.nickname })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
}

export async function emailTakenByOther(db: Db, email: string, exceptUserId: number) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(
      embedFrag(noCaseEq('{COL}', '?'), sql`${users.email}`, email),
      sql`${users.id} <> ${exceptUserId}`,
    ))
    .limit(1);
  return row ?? null;
}

export async function updateUserProfile(
  db: Db,
  id: number,
  patch: {
    nickname?: string;
    email?: string;
    locale?: string | null;
    isDarkMode?: boolean;
    signature?: string;
    avatarTextureId?: number | null;
    emailVerifiedAt?: number | null;
  },
) {
  await db.update(users).set({ ...patch, updatedAt: Date.now() }).where(eq(users.id, id));
}

export async function updateUserPassword(db: Db, id: number, hash: string) {
  await db.update(users).set({
    passwordHash: hash,
    passwordRehashRequired: false,
    updatedAt: Date.now(),
  }).where(eq(users.id, id));
}

/** 记录签到并加分。返回新的分数。 */
export async function applySignIn(d1: D1Bind, userId: number, reward: number, at: number, cutoff: number): Promise<number | null> {
  const row = await d1
    .prepare('UPDATE users SET score = score + ?, last_sign_at = ?, updated_at = ? WHERE id = ? AND (last_sign_at IS NULL OR last_sign_at <= ?) RETURNING score')
    .bind(reward, at, at, userId, cutoff)
    .first<{ score: number }>();
  return row?.score ?? null;
}

/** 玩家数与已用存储（KB），面板的用量条用 */
export async function readUsage(db: Db, userId: number) {
  const [playerRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(players)
    .where(eq(players.userId, userId));

  const [storageRow] = await db
    .select({ kb: sql<number>`COALESCE(SUM(${textures.sizeBytes}), 0) / 1024.0` })
    .from(textures)
    .where(eq(textures.uploaderId, userId));

  return { players: playerRow?.n ?? 0, storageKb: storageRow?.kb ?? 0 };
}

/** 撤销除当前会话外的全部会话（改密码时用） */
export async function revokeOtherSessions(d1: D1Bind, userId: number, keepSessionId: string) {
  await d1
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL')
    .bind(Date.now(), userId, keepSessionId)
    .run();
}

interface D1Bind {
  prepare: (sql: string) => { bind: (...args: unknown[]) => { run: () => Promise<unknown>; first: <T>() => Promise<T | null> } };
}
