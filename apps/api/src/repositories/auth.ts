// 认证仓储 —— 只负责查询。
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { eq, sql } from 'drizzle-orm';
import { players, users } from '@pigeon-skin/db';
import type { Db } from './textures.ts';

export interface AuthUserRow {
  id: number;
  email: string;
  nickname: string;
  role: string;
  passwordHash: string;
  emailVerifiedAt: number | null;
  mergedIntoUserId: number | null;
}

export async function findUserByEmail(db: Db, email: string) {
  const [row] = await db
    .select({
      id: users.id, email: users.email, nickname: users.nickname,
      role: users.role, passwordHash: users.passwordHash,
      emailVerifiedAt: users.emailVerifiedAt,
      mergedIntoUserId: users.mergedIntoUserId,
    })
    .from(users)
    // 邮箱唯一性不区分大小写（UNIQUE ... COLLATE NOCASE），查询也必须按 NOCASE
    .where(sql`${users.email} = ${email} COLLATE NOCASE`)
    .orderBy(users.mergedIntoUserId, users.id)
    .limit(1);
  return row ?? null;
}

export async function findEmailConflicts(db: Db, email: string) {
  return db.select({ id: users.id, email: users.email, nickname: users.nickname, role: users.role, passwordHash: users.passwordHash, emailVerifiedAt: users.emailVerifiedAt, mergedIntoUserId: users.mergedIntoUserId })
    .from(users).where(sql`${users.email} = ${email} COLLATE NOCASE AND ${users.legacyEmailConflict} = 1 AND ${users.mergedIntoUserId} IS NULL`).orderBy(users.id).limit(9);
}

/** 按 id 取用户的合并状态（判定冲突选择竞态的输家/赢家）。 */
export async function findUserMergeState(db: Db, id: number) {
  const [row] = await db
    .select({ role: users.role, mergedIntoUserId: users.mergedIntoUserId })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * 用玩家名找用户。
 *
 * 旧版允许用玩家名登录 —— Minecraft 用户记得住角色名，记不住注册邮箱，
 * 这个行为值得保留。玩家名在任何规则下都不含 `@`，所以与邮箱命名空间不会冲突。
 */
export async function findUserByPlayerName(db: Db, name: string) {
  const [row] = await db
    .select({
      id: users.id, email: users.email, nickname: users.nickname,
      role: users.role, passwordHash: users.passwordHash,
      emailVerifiedAt: users.emailVerifiedAt,
      mergedIntoUserId: users.mergedIntoUserId,
    })
    .from(players)
    .innerJoin(users, eq(users.id, players.userId))
    .where(sql`${players.name} = ${name} COLLATE NOCASE`)
    .limit(1);
  return row ?? null;
}

export async function countUsersByIp(db: Db, ip: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.registrationIp, ip));
  return row?.n ?? 0;
}

export async function playerNameExists(db: Db, name: string): Promise<boolean> {
  const [row] = await db
    .select({ id: players.id })
    .from(players)
    .where(sql`${players.name} = ${name} COLLATE NOCASE`)
    .limit(1);
  return row !== undefined;
}

export async function insertUser(
  db: Db,
  row: {
    email: string; nickname: string; score: number; passwordHash: string;
    registrationIp: string; createdAt: number;
  },
) {
  const [inserted] = await db.insert(users).values({
    email: row.email,
    nickname: row.nickname,
    score: row.score,
    passwordHash: row.passwordHash,
    role: 'normal',
    registrationIp: row.registrationIp,
    emailVerifiedAt: null,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  }).returning({ id: users.id });
  return inserted!.id;
}

export async function insertPlayer(db: Db, row: { userId: number; name: string; createdAt: number }) {
  await db.insert(players).values({
    userId: row.userId,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  });
}

export async function updatePasswordHash(db: Db, userId: number, hash: string) {
  await db.update(users).set({
    passwordHash: hash,
    passwordRehashRequired: false,
    updatedAt: Date.now(),
  }).where(eq(users.id, userId));
}

export async function recordAttempt(
  d1: { prepare: (sql: string) => D1PreparedStatement },
  row: { ip: string; identifier: string | null; kind: 'login' | 'register' | 'forgot'; succeeded: boolean },
) {
  await d1
    .prepare(
      `INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(row.ip, row.identifier, row.kind, row.succeeded ? 1 : 0, Date.now())
    .run();
}

/**
 * 某登录标识在窗口内的近期失败次数（不含本次）。
 *
 * 用于决定"是否要求验证码"。按 identifier（邮箱或玩家名）计数而不是按 IP：
 * NAT 后面的许多正常用户共享一个出口 IP，按 IP 计数会把他们一起拖进
 * 验证码升级；而撞库攻击是围绕特定账号的。
 */
export async function countRecentFailures(
  d1: { prepare: (sql: string) => D1PreparedStatement },
  identifier: string,
  windowMs: number,
): Promise<number> {
  const result = await d1
    .prepare(
      `SELECT COUNT(*) AS n FROM auth_attempts
       WHERE kind = 'login' AND succeeded = 0 AND identifier = ? AND created_at > ?`,
    )
    .bind(identifier, Date.now() - windowMs)
    .first<{ n: number }>();
  return result?.n ?? 0;
}
