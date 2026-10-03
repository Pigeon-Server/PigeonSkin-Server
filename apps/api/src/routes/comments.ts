import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { createDb, comments, textures, users } from '@pigeon-skin/db';
import { AppError, currentAdmin, currentUser, fail, paginate, readPagination } from '../framework.ts';
import { getSettingBool, type AppEnv } from '../lib.ts';

type Ctx = Context<AppEnv>;

/** AI 审核结果 */
interface ModerationVerdict {
  action: 'allow' | 'reject' | 'flag';
  reason?: string;
}

async function moderate(c: Ctx, content: string): Promise<ModerationVerdict> {
  if (!await getSettingBool(c.env, 'comments_ai_moderation')) return { action: 'allow' };
  if (!c.env.AI) return { action: 'allow' }; // 无 AI 绑定 fail-open

  try {
    const started = Date.now();
    const pending = c.env.AI.run('@cf/meta/llama-guard-3-8b', {
      messages: [{ role: 'user', content }],
      max_tokens: 64,
      temperature: 0,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Comment moderation timed out')), 25_000); });
    const result = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer)) as { response?: string; safe?: boolean; category?: string } | string;

    const elapsed = Date.now() - started;
    if (elapsed > 8000) console.warn('AI 审核耗时偏高', elapsed);

    const text = typeof result === 'string' ? result : (result.response ?? '');
    const parsed = typeof result === 'object' && typeof result.safe === 'boolean' ? result : safeParse(text);
    if (parsed === null) return { action: 'allow' }; // 解析失败 fail-open
    if (parsed.safe === false) {
      return { action: 'reject', ...(parsed.category ? { reason: parsed.category } : {}) };
    }
    return { action: 'allow' };
  } catch (e) {
    console.error('AI 审核失败（fail-open）', e);
    return { action: 'allow' };
  }
}

function safeParse(text: string): { safe?: boolean; category?: string } | null {
  try {
    const json = JSON.parse(text.replace(/^```json\s*|```\s*$/g, '')) as {
      safe?: boolean; category?: string;
    };
    if (typeof json === 'object' && json !== null) {
      return {
        ...(typeof json.safe === 'boolean' ? { safe: json.safe } : {}),
        ...(json.category !== undefined ? { category: json.category } : {}),
      };
    }
    return null;
  } catch {
    // llama-guard 原生输出 "safe"/"S1\n..." 形态
    const t = text.trim().toUpperCase();
    if (t === 'SAFE') return { safe: true };
    if (t.startsWith('UNSAFE') || /^S\d/.test(t)) {
      const category = t.startsWith('UNSAFE') ? t.split('\n').slice(1).join(', ') : t;
      return { safe: false, ...(category ? { category } : {}) };
    }
    return null;
  }
}

async function assertTextureVisible(c: Ctx, textureId: number): Promise<void> {
  const [t] = await createDb(c.env.DB)
    .select({ visibility: textures.visibility, uploaderId: textures.uploaderId })
    .from(textures).where(eq(textures.id, textureId)).limit(1);
  if (!t) throw fail.notFound('texture.not_found');
  if (t.visibility === 'private') {
    const user = currentUser(c);
    if (t.uploaderId !== user.id && user.role !== 'admin' && user.role !== 'super_admin') {
      throw fail.notFound('texture.not_found');
    }
  }
}

export const commentRoutes = new Hono<AppEnv>();
export const commentAdminRoutes = new Hono<AppEnv>();

commentRoutes.get('/textures/:id/comments', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw fail.notFound();
  await assertTextureVisible(c, id);

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
  await assertTextureVisible(c, id);

  if (!await getSettingBool(c.env, 'comments_enabled')) {
    throw fail.forbidden('comment.disabled');
  }

  const body: { content?: unknown } = await c.req.json().catch(() => ({}));
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (content.length === 0) throw fail.invalid('common.invalid_request', { content: 'required' });
  if (content.length > 500) throw fail.invalid('comment.too_long');

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

  const reviewing = !!c.env.AI && await getSettingBool(c.env, 'comments_ai_moderation');

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
    const verdict = await moderate(c, content);
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
