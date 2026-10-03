import { Hono } from 'hono';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { currentAdmin, fail, readJson } from '../framework.ts';
import type { AppEnv } from '../lib.ts';
import { assetType, getModel, listModels, readDisplay, saveDisplay, uploadModel } from '../services/live2d.ts';
import { audit } from '../services/audit.ts';

export const live2dRoutes = new Hono<AppEnv>();

live2dRoutes.get('/live2d', async c => {
  c.header('Cache-Control', 'no-store');
  return c.json(await readDisplay(c.env));
});

live2dRoutes.get('/live2d/assets/:id/*', async c => {
  const id = c.req.param('id');
  if (!await getModel(c.env, id) || id === 'aoba') throw fail.notFound();
  let path: string;
  try { path = decodeURIComponent(new URL(c.req.url).pathname.split(`/assets/${id}/`)[1] || ''); } catch { throw fail.notFound(); }
  if (!path || /[\\\x00-\x1f:%?#]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || !assetType(path)) throw fail.notFound();
  const object = await c.env.BUCKET.get(`live2d/models/${id}/${path}`);
  if (!object) throw fail.notFound();
  c.header('Content-Type', assetType(path)!);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', "default-src 'none'; sandbox");
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(object.body);
});

live2dRoutes.get('/admin/live2d', async c => {
  currentAdmin(c);
  c.header('Cache-Control', 'no-store');
  return c.json({ display: await readDisplay(c.env), items: await listModels(c.env) });
});

live2dRoutes.post('/admin/live2d/models', async (c, next) => { currentAdmin(c); await next(); }, bodyLimit({ maxSize: 21 * 1024 * 1024, onError: c => c.json({ error: 'common.invalid_request', fields: { file: 'live2d.too_large' } }, 422) }), async c => {
  const actor = currentAdmin(c);
  const length = Number(c.req.header('content-length'));
  if (length > 21 * 1024 * 1024) throw fail.invalid('common.invalid_request', { file: 'live2d.too_large' });
  let form: FormData;
  try { form = await c.req.formData(); } catch { throw fail.invalid('common.invalid_request', { file: 'live2d.invalid_archive' }); }
  const file = form.get('file') as unknown as File | null;
  const name = z.string().trim().min(1).max(100).parse(form.get('name'));
  if (!file || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string' || !file.name.toLowerCase().endsWith('.zip')) throw fail.invalid('common.invalid_request', { file: 'live2d.invalid_archive' });
  if (file.size > 20 * 1024 * 1024) throw fail.invalid('common.invalid_request', { file: 'live2d.too_large' });
  const info = await uploadModel(c.env, name, new Uint8Array(await file.arrayBuffer()));
  await audit(c.env, { actorId: actor.id, action: 'admin.live2d.upload', detail: info.id });
  return c.json(info, 201);
});

live2dRoutes.put('/admin/live2d', async c => {
  const actor = currentAdmin(c);
  const body = await readJson(c, z.object({ enabled: z.boolean(), modelId: z.string().min(1).max(50) }).strict());
  const display = await saveDisplay(c.env, body.enabled, body.modelId);
  await audit(c.env, { actorId: actor.id, action: 'admin.live2d.update', detail: JSON.stringify(body) });
  return c.json(display);
});
