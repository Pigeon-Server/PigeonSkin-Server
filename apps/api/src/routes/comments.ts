import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { createDb, comments, textures, users } from '@pigeon-skin/db';
import { AppError, currentAdmin, currentUser, fail, paginate, readPagination } from '../framework.ts';
import { isModerationConfigured, moderateComment } from '../services/ai-gateway.ts';
import { captchaAllows, verifyCaptcha } from '../services/captcha.ts';
import { clientIp, getSettingBool, type AppEnv } from '../lib.ts';

type Ctx = Context<AppEnv>;

// 评论区只存在于公开的非官方材质：私密材质不设评论区（拥有者与管理员亦然），
// 对任何人都不可读、不可评，避免借评论侧信道披露私密材质的存在；
// 官方材质是站点自有内容，不提供社区评论通道。
async function assertTextureCommentable(c: Ctx, textureId: number): Promise<void> {
  const [t] = await createDb(c.env.DB)
    .select({ visibility: textures.visibility, official: sql<boolean>`${textures.officialKey} IS NOT NULL`.mapWith(Boolean) })
    .from(textures).where(eq(textures.id, textureId)).limit(1);
  if (!t || t.visibility !== 'public') throw fail.notFound('texture.not_found');
  if (t.official) throw fail.forbidden('comment.official_disabled');
}

export const commentRoutes = new Hono<AppEnv>();
export const commentAdminRoutes = new Hono<AppEnv>();

commentRoutes.get('/textures/:id/comments', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw fail.notFound();
  await assertTextureCommentable(c, id);

  const page = readPagination(c, { defaultPerPage: 20 });
  const db = createDb(c.env.DB);
  const viewer = c.get('user');
  const visible = and(eq(comments.textureId, id), or(
    eq(comments.status, 'published'),
    viewer ? and(eq(comments.userId, viewer.id), inArray(comments.status, ['pending', 'rejected'])) : undefined,
  ));
  const items = await db
    .select({
      id: comments.id,
      userId: comments.userId,
      userName: comments.userName,
      avatarTextureId: users.avatarTextureId,
      content: comments.content,
      status: comments.status,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.userId))
    .where(visible)
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(page.perPage).offset(page.offset);
  const totalRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(comments)
    .where(visible);

  c.header('Cache-Control', 'private, no-store');
  return c.json(paginate(items, totalRows[0]?.n ?? 0, page));
});

commentRoutes.post('/textures/:id/comments', async (c) => {
  const user = currentUser(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw fail.notFound();
  await assertTextureCommentable(c, id);

  if (!await getSettingBool(c.env, 'comments_enabled')) {
    throw fail.forbidden('comment.disabled');
  }

  // 管理员禁用了评论权限的用户不能发言（防滥用）
  const [commenter] = await createDb(c.env.DB).select({ commentsDisabled: users.commentsDisabled }).from(users).where(eq(users.id, user.id)).limit(1);
  if (commenter?.commentsDisabled) throw fail.forbidden('comment.user_disabled');

  const body: { content?: unknown; captchaToken?: unknown; captchaRandstr?: unknown } = await c.req.json().catch(() => ({}));
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (content.length === 0) throw fail.invalid('common.invalid_request', { content: 'required' });
  if (content.length > 500) throw fail.invalid('comment.too_long');

  // 防刷靠验证码；验证码未启用时 verifyCaptcha 返回 disabled，放行
  const verdict = await verifyCaptcha(
    c.env,
    { token: typeof body.captchaToken === 'string' ? body.captchaToken : '', randstr: typeof body.captchaRandstr === 'string' ? body.captchaRandstr : '' },
    clientIp(c),
  );
  if (!captchaAllows(verdict, false)) throw fail.forbidden('auth.captcha_failed');

  // 发言频率：单纹理 10 秒一条 + 全局每分钟 5 条（AI fail-open 时这是主防线）
  const recent = await createDb(c.env.DB)
    .select({ createdAt: comments.createdAt })
    .from(comments)
    .where(and(eq(comments.userId, user.id), eq(comments.textureId, id)))
    .orderBy(desc(comments.createdAt)).limit(1);
  if (recent[0] && Date.now() - recent[0].createdAt < 10_000) {
    throw new AppError('comment.rate_limited', 429);
  }
  const globalRecent = await createDb(c.env.DB)
    .select({ n: sql<number>`count(*)` })
    .from(comments)
    .where(and(eq(comments.userId, user.id), gt(comments.createdAt, Date.now() - 60_000)));
  if ((globalRecent[0]?.n ?? 0) >= 5) {
    throw new AppError('comment.rate_limited', 429);
  }

  const reviewing = await getSettingBool(c.env, 'comments_ai_moderation') && await isModerationConfigured(c.env);

  const [created] = await createDb(c.env.DB)
    .insert(comments)
    .values({
      textureId: id,
      userId: user.id,
      userName: user.nickname,
      content,
      status: reviewing ? 'pending' : 'published',
      aiFlagged: false,
      createdAt: Date.now(),
    })
    .returning({ id: comments.id });

  if (reviewing) c.executionCtx.waitUntil((async () => {
    const verdict = await moderateComment(c.env, content);
    await createDb(c.env.DB).update(comments).set({
      status: verdict.action === 'reject' ? 'rejected' : 'published',
      aiFlagged: verdict.action !== 'allow',
    }).where(and(eq(comments.id, created!.id), eq(comments.status, 'pending')));
  })());
  return c.json({ ok: true, id: created!.id, status: reviewing ? 'pending' : 'published', aiFlagged: false }, 201);
});

// ── 管理员 ───────────────────────────────────────────────────────────────────

commentAdminRoutes.get('/comments', async (c) => {
  currentAdmin(c);
  const page = readPagination(c, { defaultPerPage: 20 });
  const status = c.req.query('status');
  const db = createDb(c.env.DB);
  const where = status === 'published' || status === 'deleted' || status === 'pending' || status === 'rejected'
    ? eq(comments.status, status) : undefined;
  const items = await db
    .select({
      id: comments.id,
      textureId: comments.textureId,
      userId: comments.userId,
      userName: comments.userName,
      content: comments.content,
      status: comments.status,
      aiFlagged: comments.aiFlagged,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(where)
    .orderBy(desc(comments.createdAt))
    .limit(page.perPage).offset(page.offset);
  const totalRows = await db.select({ n: sql<number>`count(*)` }).from(comments).where(where);
  return c.json(paginate(items, totalRows[0]?.n ?? 0, page));
});

commentAdminRoutes.delete('/comments/:id', async (c) => {
  const admin = currentAdmin(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw fail.notFound();
  const { audit } = await import('../services/audit.ts');
  const result = await createDb(c.env.DB)
    .update(comments).set({ status: 'deleted' })
    .where(eq(comments.id, id)).run();
  if ((result.meta.changes ?? 0) === 0) throw fail.notFound('comment.not_found');
  await audit(c.env, {
    actorId: admin.id, action: 'admin.comment.delete', targetType: 'comment', targetId: id,
  });
  return c.body(null, 204);
});

// 用户删除自己的评论
commentRoutes.delete('/comments/:id', async (c) => {
  const user = currentUser(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw fail.notFound();
  const db = createDb(c.env.DB);
  const [row] = await db.select({ userId: comments.userId })
    .from(comments).where(eq(comments.id, id)).limit(1);
  if (!row) throw fail.notFound('comment.not_found');
  if (row.userId !== user.id && user.role !== 'admin' && user.role !== 'super_admin') {
    // 别人的评论按不存在处理，避免 id 探测
    throw fail.notFound('comment.not_found');
  }
  await db.update(comments).set({ status: 'deleted' }).where(eq(comments.id, id));
  return c.body(null, 204);
});
