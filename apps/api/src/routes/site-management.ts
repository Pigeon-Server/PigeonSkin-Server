import { Hono } from 'hono';
import { z } from 'zod';
import { hashPassword } from '@pigeon-skin/auth';
import { currentAdmin, fail, readJson } from '../framework.ts';
import { audit } from '../services/audit.ts';
import { invalidateSettingsCache, type AppEnv } from '../lib.ts';
import { adminCreateUserInputSchema } from '@pigeon-skin/shared/schemas';
import { LOCALES, UI_MESSAGES, validateMessage } from '@pigeon-skin/shared/i18n';
import { getMessage, messageParameters, normalizeTranslation } from '@pigeon-skin/shared/messages';
import { invalidateTranslationCache } from '../services/translations.ts';
import { readAll } from '../services/settings.ts';

export const siteManagementRoutes = new Hono<AppEnv>();
const version = '7.0.0';
siteManagementRoutes.get('/site-script.js', async (c) => {
  c.header('Content-Type', 'application/javascript; charset=utf-8');
  c.header('Cache-Control', 'no-cache');
  const settings = await readAll(c.env);
  return c.body(settings['custom_js'] ?? '');
});
const localeSchema = z.enum(LOCALES);
const keySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z][\w-]*(?:\.[\w-]+)+$/)
  .refine(
    (key) =>
      !key
        .split('.')
        .some((segment) => ['__proto__', 'constructor', 'prototype'].includes(segment)),
  );
const translationSchema = z.object({
  locale: localeSchema,
  key: keySchema,
  value: z.string().min(1).max(10000),
});

siteManagementRoutes.get('/translations', async (c) => {
  const locale = localeSchema.safeParse(c.req.query('locale') || 'zh_CN');
  if (!locale.success) throw fail.invalid();
  const { results } = await c.env.DB.prepare(
    'SELECT key, value FROM translation_overrides WHERE locale = ? ORDER BY key',
  )
    .bind(locale.data)
    .all<{ key: string; value: string }>();
  return c.json({ items: results });
});

siteManagementRoutes.get('/admin/translations', async (c) => {
  currentAdmin(c);
  const { results } = await c.env.DB.prepare(
    'SELECT locale, key, value, updated_at AS updatedAt FROM translation_overrides ORDER BY locale, key',
  ).all();
  return c.json({ items: results });
});

siteManagementRoutes.put('/admin/translations', async (c) => {
  const actor = currentAdmin(c);
  const body = await readJson(c, translationSchema);
  const reference = getMessage(UI_MESSAGES.en, body.key);
  if (reference === undefined) throw fail.invalid(undefined, { key: 'unknown' });
  body.value = normalizeTranslation(body.value, reference);
  if (JSON.stringify(messageParameters(body.value)) !== JSON.stringify(messageParameters(reference))) throw fail.invalid(undefined, { value: 'parameters' });
  try { validateMessage(body.locale, body.key, body.value); }
  catch { throw fail.invalid(undefined, { value: 'syntax' }); }
  await c.env.DB.prepare(
    'INSERT INTO translation_overrides (locale, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(locale, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  )
    .bind(body.locale, body.key, body.value, Date.now())
    .run();
  invalidateTranslationCache();
  await audit(c.env, {
    actorId: actor.id,
    action: 'admin.translation.update',
    detail: `${body.locale}:${body.key}`,
  });
  return c.json({ ok: true });
});

siteManagementRoutes.delete('/admin/translations', async (c) => {
  const actor = currentAdmin(c);
  const locale = localeSchema.safeParse(c.req.query('locale'));
  const key = keySchema.safeParse(c.req.query('key'));
  if (!locale.success || !key.success) throw fail.invalid();
  await c.env.DB.prepare('DELETE FROM translation_overrides WHERE locale = ? AND key = ?')
    .bind(locale.data, key.data)
    .run();
  invalidateTranslationCache();
  await audit(c.env, {
    actorId: actor.id,
    action: 'admin.translation.delete',
    detail: `${locale.data}:${key.data}`,
  });
  return c.body(null, 204);
});

siteManagementRoutes.get('/admin/chart', async (c) => {
  currentAdmin(c);
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 30);
  const sql = (table: 'users' | 'textures') =>
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS date, count(*) AS n FROM ${table} WHERE created_at >= ? GROUP BY date`,
    )
      .bind(start.getTime())
      .all<{ date: string; n: number }>();
  const [users, textures] = await Promise.all([sql('users'), sql('textures')]);
  const items = Array.from({ length: 31 }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10);
    return {
      date,
      users: users.results.find((row) => row.date === date)?.n || 0,
      textures: textures.results.find((row) => row.date === date)?.n || 0,
    };
  });
  return c.json(items);
});

siteManagementRoutes.get('/admin/status', async (c) => {
  currentAdmin(c);
  const started = Date.now();
  const [database, storage] = await Promise.allSettled([
    c.env.DB.prepare('SELECT 1').first(),
    c.env.BUCKET.list({ limit: 1 }),
  ]);
  return c.json({
    version,
    environment: c.env.ENVIRONMENT,
    database: database.status === 'fulfilled',
    storage: storage.status === 'fulfilled',
    latencyMs: Date.now() - started,
  });
});

siteManagementRoutes.get('/admin/update', async (c) => {
  currentAdmin(c);
  let latest: { version: string; notes: string; url: string } | null = null;
  if (c.env.UPDATE_MANIFEST_URL) {
    const url = new URL(c.env.UPDATE_MANIFEST_URL);
    if (url.protocol !== 'https:') throw fail.invalid();
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw fail.invalid();
    const manifest = z
      .object({
        version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
        notes: z.string().max(20000),
        url: z.string().url().startsWith('https://'),
      })
      .safeParse(await response.json());
    if (!manifest.success) throw fail.invalid();
    latest = manifest.data;
  }
  return c.json({ current: version, latest, deployConfigured: !!c.env.DEPLOY_HOOK_URL });
});

siteManagementRoutes.post('/admin/update', async (c) => {
  const actor = currentAdmin(c);
  if (actor.role !== 'super_admin') throw fail.forbidden('admin.forbidden');
  if (!c.env.DEPLOY_HOOK_URL) throw fail.invalid();
  const url = new URL(c.env.DEPLOY_HOOK_URL);
  if (url.protocol !== 'https:') throw fail.invalid();
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw fail.invalid();
  await audit(c.env, { actorId: actor.id, action: 'admin.update.deploy' });
  return c.json({ ok: true });
});

siteManagementRoutes.get('/setup', async (c) => {
  const row = await c.env.DB.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>();
  return c.json({ locked: !!row?.n, available: !!c.env.SETUP_TOKEN });
});

siteManagementRoutes.post('/setup', async (c) => {
  const body = await readJson(
    c,
    adminCreateUserInputSchema
      .omit({ role: true })
      .extend({ token: z.string().min(1), siteName: z.string().trim().min(1).max(100) }),
  );
  if (!c.env.SETUP_TOKEN) throw fail.forbidden();
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [provided, expected] = await Promise.all([digest(body.token), digest(c.env.SETUP_TOKEN)]);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= provided[i]! ^ expected[i]!;
  if (mismatch !== 0) throw fail.forbidden();
  const nonce = crypto.randomUUID();
  const password = await hashPassword(body.password);
  const now = Date.now();
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO setup_guard (id, nonce, created_at) SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)',
    ).bind(nonce, now),
    c.env.DB.prepare(
      "INSERT INTO users (email, nickname, password_hash, role, score, created_at, updated_at) SELECT ?, ?, ?, 'super_admin', 1000, ?, ? WHERE EXISTS (SELECT 1 FROM setup_guard WHERE nonce = ?)",
    ).bind(body.email, body.nickname, password, now, now, nonce),
    c.env.DB.prepare(
      "INSERT INTO settings (key, locale, value, updated_at) SELECT 'site_name', '', ?, ? WHERE EXISTS (SELECT 1 FROM setup_guard WHERE nonce = ?) ON CONFLICT(key, locale) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(body.siteName, now, nonce),
  ]);
  if (!result[1]?.meta.changes) throw fail.conflict('auth.registration_disabled');
  invalidateSettingsCache();
  return c.json({ ok: true }, 201);
});
