import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { manualPages, manualDocumentInput, validManualSlug, type ManualDocument } from '@pigeon-skin/shared/manual';
import { AppError, currentAdmin, fail, readJson } from '../framework.ts';
import type { AppEnv } from '../lib.ts';
import { audit } from '../services/audit.ts';
import { bumpSitemap } from '../services/sitemap-cache.ts';
import { isLocale, DEFAULT_LOCALE, type Locale } from '@pigeon-skin/shared/locales';
import { manualStorageLocale, readLocalizedManual } from '../services/manual.ts';

export const manualRoutes = new Hono<AppEnv>();
function slugFor(value: string) {
  const slug = value === 'welcome' ? '' : value;
  if (!validManualSlug(slug)) throw fail.invalid();
  return slug;
}
function changed() { return new AppError('manual.changed', 409); }
function localeFor(value: string | undefined): Locale {
  const locale = value || DEFAULT_LOCALE;
  if (!isLocale(locale)) throw fail.invalid();
  return locale;
}

manualRoutes.get('/manual', async c => {
  const locale = localeFor(c.req.query('locale'));
  const { items, overrides } = await readLocalizedManual(c.env, locale);
  c.header('Cache-Control', 'no-store');
  return c.json({ siteUrl: c.env.APP_URL, locale, items, overrides });
});

manualRoutes.use('/admin/manual/*', async (c, next) => { currentAdmin(c); await next(); });
manualRoutes.put('/admin/manual/:slug', bodyLimit({ maxSize: 1_300_000, onError: c => c.json({ error: 'common.invalid_request' }, 422) }), async c => {
  const actor = currentAdmin(c);
  const slug = slugFor(c.req.param('slug'));
  const locale = localeFor(c.req.query('locale'));
  const storageLocale = manualStorageLocale(locale);
  const { revision, ...input } = await readJson(c, manualDocumentInput);
  const document = { ...input, group: input.group || manualPages.find(page => page.slug === slug)?.group || '自定义文档' };
  const now = Math.max(Date.now(), revision + 1);
  const value = JSON.stringify(document);
  const result = revision === 0
    ? await c.env.DB.prepare("INSERT INTO manual_documents (slug, locale, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(slug, locale) DO NOTHING").bind(slug, storageLocale, value, now).run()
    : await c.env.DB.prepare('UPDATE manual_documents SET value = ?, updated_at = ? WHERE slug = ? AND locale = ? AND updated_at = ?').bind(value, now, slug, storageLocale, revision).run();
  if (!result.meta.changes) throw changed();
  c.executionCtx.waitUntil(bumpSitemap());
  await audit(c.env, { actorId: actor.id, action: 'admin.settings.update', targetType: 'manual', detail: `${locale}:${slug || 'welcome'}` });
  c.header('Cache-Control', 'no-store');
  return c.json({ slug, locale, ...document, updatedAt: now } satisfies ManualDocument);
});
manualRoutes.delete('/admin/manual/:slug', async c => {
  const actor = currentAdmin(c);
  const slug = slugFor(c.req.param('slug'));
  const locale = localeFor(c.req.query('locale'));
  const storageLocale = manualStorageLocale(locale);
  const raw = c.req.query('revision');
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw fail.invalid();
  const revision = Number(raw);
  const result = await c.env.DB.prepare('DELETE FROM manual_documents WHERE slug = ? AND locale = ? AND updated_at = ?').bind(slug, storageLocale, revision).run();
  if (!result.meta.changes && (revision !== 0 || await c.env.DB.prepare('SELECT slug FROM manual_documents WHERE slug = ? AND locale = ?').bind(slug, storageLocale).first())) throw changed();
  c.executionCtx.waitUntil(bumpSitemap());
  await audit(c.env, { actorId: actor.id, action: 'admin.settings.update', targetType: 'manual', detail: `reset:${locale}:${slug || 'welcome'}` });
  return c.body(null, 204);
});
