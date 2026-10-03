import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MANUAL_ASSET_MAX_BYTES, type ManualAsset } from '@pigeon-skin/shared/manual';
import { AppError, currentAdmin, fail } from '../framework.ts';
import type { AppEnv } from '../lib.ts';
import { audit } from '../services/audit.ts';

export const manualAssetRoutes = new Hono<AppEnv>();
const objectPrefix = 'manual/assets/';
const validId = /^[a-f0-9]{64}\.(png|jpg|gif|webp|mp3|wav|ogg|flac|m4a|mp4|webm|weba)$/;
function checkId(id: string) { if (!validId.test(id)) throw fail.notFound(); return id; }
function detect(bytes: Uint8Array, name: string): { kind: ManualAsset['kind']; mime: string; ext: string } {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const ext = name.split('.').at(-1)?.toLowerCase();
  if (starts(137,80,78,71,13,10,26,10)) return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (starts(255,216,255)) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: 'wav' };
  if (text(0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' };
  if (text(0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac', ext: 'flac' };
  if (text(0, 3) === 'ID3' || (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
  if (text(4, 4) === 'ftyp' && ext === 'm4a') return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };
  if (text(4, 4) === 'ftyp' && ext === 'mp4') return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  if (starts(26,69,223,163) && ext === 'weba') return { kind: 'audio', mime: 'audio/webm', ext: 'weba' };
  if (starts(26,69,223,163) && ext === 'webm') return { kind: 'video', mime: 'video/webm', ext: 'webm' };
  throw fail.invalid('manual.asset_invalid');
}
async function references(c: Parameters<typeof currentAdmin>[0], url: string) {
  const rows = await c.env.DB.prepare('SELECT value FROM manual_documents').all<{ value: string }>();
  return rows.results.flatMap(row => {
    try { const document = JSON.parse(row.value); return typeof document.content === 'string' && document.content.includes(url) ? [String(document.title || '')] : []; }
    catch { return []; }
  });
}
manualAssetRoutes.use('/admin/manual/assets', async (c, next) => { currentAdmin(c); await next(); });
manualAssetRoutes.use('/admin/manual/assets/*', async (c, next) => { currentAdmin(c); await next(); });
manualAssetRoutes.get('/admin/manual/assets', async c => {
  const page = Number(c.req.query('page') || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw fail.invalid();
  const rows = await c.env.DB.prepare('SELECT value FROM manual_assets ORDER BY uploaded_at DESC, id LIMIT 50 OFFSET ?').bind((page - 1) * 50).all<{ value: string }>();
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM manual_assets').first<{ n: number }>();
  const items: ManualAsset[] = [];
  for (const row of rows.results) {
    try { const asset = JSON.parse(row.value) as ManualAsset; if (validId.test(asset.id)) items.push({ ...asset, usedBy: await references(c, asset.url) }); }
    catch {}
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ items, total: total?.n || 0, page });
});
manualAssetRoutes.post('/admin/manual/assets', bodyLimit({ maxSize: MANUAL_ASSET_MAX_BYTES + 1024 * 1024, onError: c => c.json({ error: 'manual.asset_too_large' }, 422) }), async c => {
  const actor = currentAdmin(c);
  const form = await c.req.raw.formData();
  const file = form.get('file') as File | string | null;
  if (!file || typeof file === 'string' || !file.size) throw fail.invalid('manual.asset_invalid');
  if (file.size > MANUAL_ASSET_MAX_BYTES) throw fail.invalid('manual.asset_too_large');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detect(bytes, file.name);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const id = [...digest].map(value => value.toString(16).padStart(2, '0')).join('') + '.' + type.ext;
  const existing = await c.env.DB.prepare('SELECT value FROM manual_assets WHERE id = ?').bind(id).first<{ value: string }>();
  if (existing) return c.json(JSON.parse(existing.value) as ManualAsset);
  const asset: ManualAsset = { id, name: file.name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200), kind: type.kind, mime: type.mime, size: file.size, url: `/api/v1/manual/assets/${id}`, uploadedAt: Date.now() };
  await c.env.BUCKET.put(objectPrefix + id, bytes, { httpMetadata: { contentType: type.mime } });
  await c.env.DB.prepare('INSERT INTO manual_assets(id,value,uploaded_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(id, JSON.stringify(asset), asset.uploadedAt).run();
  await audit(c.env, { actorId: actor.id, action: 'admin.settings.update', targetType: 'manual_asset', detail: id });
  return c.json(asset, 201);
});
manualAssetRoutes.delete('/admin/manual/assets/:id', async c => {
  const actor = currentAdmin(c);
  const id = checkId(c.req.param('id'));
  const usedBy = await references(c, `/api/v1/manual/assets/${id}`);
  if (usedBy.length) throw new AppError('manual.asset_in_use', 409);
  await c.env.BUCKET.delete(objectPrefix + id);
  await c.env.DB.prepare('DELETE FROM manual_assets WHERE id = ?').bind(id).run();
  await audit(c.env, { actorId: actor.id, action: 'admin.settings.update', targetType: 'manual_asset', detail: `delete:${id}` });
  return c.body(null, 204);
});
manualAssetRoutes.get('/manual/assets/:id', async c => {
  const id = checkId(c.req.param('id'));
  const key = objectPrefix + id;
  const range = c.req.header('range');
  let offset = 0, length = 0;
  if (range) {
    const head = await c.env.BUCKET.head(key);
    if (!head) throw fail.notFound();
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return c.newResponse(null, 416, { 'Content-Range': `bytes */${head.size}` });
    const start = match[1] ? Number(match[1]) : Math.max(0, head.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= head.size || (!match[1] && Number(match[2]) === 0)) return c.newResponse(null, 416, { 'Content-Range': `bytes */${head.size}` });
    offset = start; length = end - start + 1;
  }
  const object = await c.env.BUCKET.get(key, range ? { range: { offset, length } } : undefined);
  if (!object) throw fail.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Content-Length', String(range ? length : object.size));
  if (range) headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
  else if (c.req.header('if-none-match') === object.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(object.body, { status: range ? 206 : 200, headers });
});
