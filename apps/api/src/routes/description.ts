// texture-description 内置 —— 原 texture-description 插件的语义。
//
// 端点：GET/PUT /api/v1/textures/:id/description。
// 私有纹理访问控制与详情端点同语义（403/404 可配）；PUT 仅上传者或管理员。

import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { createDb, textures, texturesDescription } from '@pigeon-skin/db';
import { AppError, currentUser, fail } from '../framework.ts';
import { getSettingInt, isAdmin, type AppEnv } from '../lib.ts';

type Ctx = Context<AppEnv>;

async function loadTexture(c: Ctx, id: number) {
  const [texture] = await createDb(c.env.DB)
    .select({ id: textures.id, uploaderId: textures.uploaderId, visibility: textures.visibility })
    .from(textures)
    .where(eq(textures.id, id))
    .limit(1);
  if (!texture) throw fail.notFound('texture.not_found');
  if (texture.visibility === 'private') {
    const user = currentUser(c);
    if (texture.uploaderId !== user.id && !isAdmin(user)) {
      const status = await getSettingInt(c.env, 'private_texture_status');
      throw new AppError(
        status === 404 ? 'common.not_found' : 'texture.private_access_denied',
        status === 404 ? 404 : 403,
      );
    }
  }
  return texture;
}

export const descriptionRoutes = new Hono<AppEnv>();

descriptionRoutes.get('/textures/:id/description', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw fail.notFound();
  await loadTexture(c, id);

  const [row] = await createDb(c.env.DB)
    .select().from(texturesDescription)
    .where(eq(texturesDescription.tid, id))
    .limit(1);
  return c.json({ description: row?.description ?? '' });
});

descriptionRoutes.put('/textures/:id/description', async (c) => {
  const user = currentUser(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw fail.notFound();

  const texture = await loadTexture(c, id);
  if (texture.uploaderId !== user.id && !isAdmin(user)) {
    throw fail.forbidden('common.forbidden');
  }

  const body: { description?: unknown } = await c.req.json().catch(() => ({}));
  const description = typeof body.description === 'string' ? body.description : '';
  const limit = await getSettingInt(c.env, 'textures_description_limit');
  if (limit > 0 && description.length > limit) {
    throw fail.invalid('common.invalid_request', { description: 'too_long' });
  }

  const now = Date.now();
  await createDb(c.env.DB)
    .insert(texturesDescription)
    .values({ tid: id, description, updatedAt: now })
    .onConflictDoUpdate({
      target: texturesDescription.tid,
      set: { description, updatedAt: now },
    });

  return c.json({ ok: true, description });
});
