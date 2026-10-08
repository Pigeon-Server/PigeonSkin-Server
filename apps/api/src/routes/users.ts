// 公开用户信息端点（创作者主页用）。
//
// 只暴露展示所需字段：不含 email/score/locale 等隐私或内部数据。
// 材质列表复用 GET /api/v1/textures?uploader={uid}，其可见性过滤在
// SQL 内强制（未登录只看 public），这里不做重复查询。

import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, textures, users } from '@pigeon-skin/db';
import { fail } from '../framework.ts';
import type { AppEnv } from '../lib.ts';

export const usersRoutes = new Hono<AppEnv>();

usersRoutes.get('/users/:id/profile', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) throw fail.notFound();

  const db = createDb(c.env.DB);
  const [user] = await db
    .select({
      id: users.id,
      nickname: users.nickname,
      signature: users.signature,
      avatarTextureId: users.avatarTextureId,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!user) throw fail.notFound();

  const counts = await db
    .select({
      kind: textures.kind,
      n: sql<number>`count(*)`,
    })
    .from(textures)
    .where(and(eq(textures.uploaderId, id), eq(textures.visibility, 'public')))
    .groupBy(textures.kind);

  const skins = counts.find((r) => r.kind === 'skin')?.n ?? 0;
  const capes = counts.find((r) => r.kind === 'cape')?.n ?? 0;
  return c.json({
    id: user.id,
    nickname: user.nickname,
    signature: user.signature,
    avatarTextureId: user.avatarTextureId,
    role: user.role,
    createdAt: user.createdAt,
    counts: { skins, capes },
  });
});
