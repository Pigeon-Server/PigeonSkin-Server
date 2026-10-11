// 登录设备管理 —— 用户查看并踢掉自己的所有已登录设备：
// 浏览器（sessions 表，含 ip/userAgent）与游戏启动器（ygg_tokens 表，
// authlib 外置登录的 accessToken，经玩家归属到用户）。
//
// 踢掉语义与登录/登出一致：会话置 revokedAt（保留记录供审计），
// 启动器令牌直接删除（与 yggdrasil refresh 端点的失效方式一致）。
// 别人的会话/令牌一律按 404 处理，避免 id 探测。

import { currentUser, fail } from '../../core/framework.ts';
import { revokeSession } from '../../core/session.ts';
import { type AppEnv } from '../../core/user.ts';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { createDb, players, sessions, yggTokens } from '@pigeon-skin/db';

type Ctx = Context<AppEnv>;

export const deviceRoutes = new Hono<AppEnv>();

deviceRoutes.get('/devices', async (c: Ctx) => {
  const user = currentUser(c);
  const db = createDb(c.env.DB);
  const now = Date.now();

  const [browserRows, launcherRows] = await Promise.all([
    db
      .select({
        id: sessions.id,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .orderBy(desc(sessions.lastSeenAt))
      .limit(50),
    db
      .select({
        id: yggTokens.id,
        playerName: players.name,
        createdAt: yggTokens.createdAt,
        expiresAt: yggTokens.expiresAt,
      })
      .from(yggTokens)
      .innerJoin(players, eq(players.id, yggTokens.playerId))
      .where(and(eq(yggTokens.userId, user.id), gt(yggTokens.expiresAt, now)))
      .orderBy(desc(yggTokens.createdAt))
      .limit(50),
  ]);

  const currentSessionId = c.get('sessionId') ?? '';
  return c.json({
    browser: browserRows.map(row => ({
      kind: 'browser' as const,
      id: row.id,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      current: row.id === currentSessionId,
    })),
    launcher: launcherRows.map(row => ({
      kind: 'launcher' as const,
      id: row.id,
      playerName: row.playerName,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    })),
  });
});

deviceRoutes.delete('/devices/session/:id', async (c: Ctx) => {
  const user = currentUser(c);
  const id = c.req.param('id') ?? '';
  if (!/^[0-9a-f]{64}$/.test(id)) throw fail.notFound();
  const db = createDb(c.env.DB);
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .limit(1);
  if (!row || row.userId !== user.id) throw fail.notFound();
  const currentSessionId = c.get('sessionId') ?? '';
  await revokeSession(c.env, id);
  return c.json({ ok: true, current: id === currentSessionId });
});

deviceRoutes.delete('/devices/launcher/:id', async (c: Ctx) => {
  const user = currentUser(c);
  const id = c.req.param('id') ?? '';
  if (!/^[0-9a-f]{64}$/.test(id)) throw fail.notFound();
  const db = createDb(c.env.DB);
  const result = await db
    .delete(yggTokens)
    .where(and(eq(yggTokens.id, id), eq(yggTokens.userId, user.id)))
    .returning({ id: yggTokens.id });
  if (result.length === 0) throw fail.notFound();
  return c.json({ ok: true });
});
