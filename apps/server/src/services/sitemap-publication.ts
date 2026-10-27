import { BLOCKED_CRAWLER_AGENTS, ROBOTS_API_RULES, ROBOTS_PROTOCOL_DISALLOW, ROBOTS_RULES_REVISION } from '../core/route-metadata.ts';
import { getSettingBool, getSettingInt } from '../core/settings-reader.ts';
import type { Bindings } from '../core/env.ts';
import { desc, eq } from 'drizzle-orm';
import { createDb, textures } from '@pigeon-skin/db';
import { LOCALES, DEFAULT_LOCALE } from '@pigeon-skin/shared/locales';
import { manualCatalog } from './seo.ts';
import { readManualDocuments } from './manual.ts';
import { resolveConfiguration } from './configuration.ts';
import { publicCacheRevision } from '../core/public-cache.ts';
import { backgroundAllowed } from '../core/usage-budget.ts';
import { invalidateSettingsCache } from '../core/settings-reader.ts';

const URLS_PER_CHUNK = 25_000;
const MANIFEST = 'seo/sitemap/manifest.json';
const scopes = ['sitemap', 'settings', 'manual', 'translations'];
interface Manifest { version: string; builtAt: number; checkedAt: number; siteUrl: string; rules: number; files: Record<string, string>; cleanupCursor: string | null }

async function cleanupGenerations(env: Bindings, previous: Manifest | null): Promise<string | null> {
  try {
    const cursor = previous?.cleanupCursor;
    const page = await env.BUCKET.list({ prefix: 'seo/sitemap/generations/', limit: 128, ...(cursor ? { cursor } : {}) });
    const retained = new Set(Object.values(previous?.files ?? {}));
    const expired = page.objects.filter(object => !retained.has(object.key) && object.uploaded.getTime() < Date.now() - 86_400_000).map(object => object.key);
    if (expired.length) await env.BUCKET.delete(expired);
    return page.truncated ? page.cursor : null;
  } catch { return previous?.cleanupCursor ?? null; }
}

interface SitemapUrls {
  staticUrls: string[];
  manualUrls: Array<{ loc: string; updatedAt: number }>;
  textureIds: Array<{ id: number; updatedAt: number }>;
}

async function collectUrls(env: Bindings, version: string): Promise<SitemapUrls> {
  const db = createDb(env.DB);
  const maxUrls = Math.min(await getSettingInt(env, 'sitemap_max_urls'), 50_000);
  const revision = version.split('|').find(part => part.startsWith('sitemap:'))!;
  const object = await env.BUCKET.get('seo/sitemap/catalog.json');
  const catalog = object ? await object.json<{ revision: string; maxUrls: number; rows: SitemapUrls['textureIds'] }>() : null;
  let textureRows: SitemapUrls['textureIds'];
  if (catalog?.revision === revision && catalog.maxUrls === maxUrls) textureRows = catalog.rows;
  else {
    textureRows = await db.select({ id: textures.id, updatedAt: textures.updatedAt }).from(textures)
      .where(eq(textures.visibility, 'public')).orderBy(desc(textures.updatedAt), desc(textures.id)).limit(maxUrls);
    await env.BUCKET.put('seo/sitemap/catalog.json', JSON.stringify({ revision, maxUrls, rows: textureRows }), { httpMetadata: { contentType: 'application/json' } });
  }

  const appUrl = env.APP_URL.replace(/\/$/, '');
  const documents = await readManualDocuments(env, true);
  const catalogs = await Promise.all(LOCALES.map(async locale => ({ locale, pages: await manualCatalog(env, locale, documents) })));
  return {
    staticUrls: [`${appUrl}/`, `${appUrl}/skinlib`],
    manualUrls: catalogs.flatMap(({ locale, pages }) => pages.map(page => ({ loc: `${appUrl}/manual${page.slug ? `/${page.slug}` : ''}${locale === DEFAULT_LOCALE ? '' : `?lang=${locale}`}`, updatedAt: page.updatedAt }))),
    textureIds: textureRows,
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function w3cDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function urlEntry(loc: string, lastmod?: string): string {
  return `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
}

/** 全量 URL 列表（静态页 + 纹理详情 + 玩家档案页），切片 */
function buildChunks(urls: SitemapUrls, appUrl: string): string[][] {
  const all: Array<{ loc: string; lastmod?: string }> = [
    ...urls.staticUrls.map((loc) => ({ loc })),
    ...urls.manualUrls.map(page => ({ loc: page.loc, ...(page.updatedAt ? { lastmod: w3cDate(page.updatedAt) } : {}) })),
    ...urls.textureIds.map((t) => ({ loc: `${appUrl}/skinlib/${t.id}`, lastmod: w3cDate(t.updatedAt) })),
  ];
  const chunks: string[][] = [];
  for (let i = 0; i < all.length; i += URLS_PER_CHUNK) {
    chunks.push(all.slice(i, i + URLS_PER_CHUNK).map((u) => urlEntry(u.loc, u.lastmod)));
  }
  if (chunks.length === 0) chunks.push(urls.staticUrls.map((loc) => urlEntry(loc)));
  return chunks;
}


export async function publishSitemap(source: Bindings): Promise<boolean> {
  if (!await backgroundAllowed(source)) return false;
  invalidateSettingsCache();
  const env = { ...await resolveConfiguration(source) };
  delete env.CACHE_PUBLISHER;
  delete env.PUBLIC_CACHE;
  const version = await publicCacheRevision(env, scopes);
  if (!version) throw new Error('Sitemap schema unavailable');
  const previous = await readManifest(env);
  const appUrl = env.APP_URL.replace(/\/$/, '');
  if (previous?.version === version && previous.rules === ROBOTS_RULES_REVISION && previous.siteUrl === appUrl && Date.now() - previous.builtAt < 86_400_000) {
    await env.BUCKET.put(MANIFEST, JSON.stringify({ ...previous, checkedAt: Date.now(), cleanupCursor: await cleanupGenerations(env, previous) }), { httpMetadata: { contentType: 'application/json' } });
    return true;
  }
  const chunks = buildChunks(await collectUrls(env, version), appUrl);
  const bodies: Record<string, string> = {};
  for (const [index, entries] of chunks.entries()) bodies[`sitemap-${index + 1}.xml`] = xmlDocument(entries);
  bodies['sitemap.xml'] = chunks.length === 1 ? bodies['sitemap-1.xml']! : `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${chunks.map((_, index) => `  <sitemap><loc>${xmlEscape(appUrl)}/sitemap-${index + 1}.xml</loc></sitemap>`).join('\n')}\n</sitemapindex>\n`;
  const allowDownload = await getSettingBool(env, 'allow_texture_download');
  bodies['robots.txt'] = [
    ...BLOCKED_CRAWLER_AGENTS.flatMap(agent => [`User-agent: ${agent}`, 'Disallow: /', '']),
    'User-agent: *', ...ROBOTS_API_RULES, ...ROBOTS_PROTOCOL_DISALLOW, 'Disallow: /manual-content.json',
    ...(allowDownload ? [] : ['Disallow: /usm/textures/', 'Disallow: /skin/']),
    '', `Sitemap: ${appUrl}/sitemap.xml`, '',
  ].join('\n');
  const generation = crypto.randomUUID();
  const files: Record<string, string> = {};
  for (const [name, body] of Object.entries(bodies)) {
    files[name] = `seo/sitemap/generations/${generation}/${name}`;
    await env.BUCKET.put(files[name], body, { httpMetadata: { contentType: name.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8' } });
  }
  if (await publicCacheRevision(env, scopes) !== version) return false;
  const cleanupCursor = await cleanupGenerations(env, previous);
  await env.BUCKET.put(MANIFEST, JSON.stringify({ version, builtAt: Date.now(), checkedAt: Date.now(), siteUrl: appUrl, rules: ROBOTS_RULES_REVISION, files, cleanupCursor } satisfies Manifest), { httpMetadata: { contentType: 'application/json' } });
  return true;
}

function xmlDocument(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

async function readManifest(env: Pick<Bindings, 'BUCKET'>): Promise<Manifest | null> {
  const object = await env.BUCKET.get(MANIFEST);
  if (!object) return null;
  return object.json<Manifest>();
}

export async function serveSitemap(request: Request, env: Bindings, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const name = new URL(request.url).pathname.slice(1);
  let manifest = await readManifest(env);
  if (!manifest) {
    if (env.CACHE_PUBLISHER) {
      const coordinator = env.CACHE_PUBLISHER.get(env.CACHE_PUBLISHER.idFromName('sitemap'));
      const result = await coordinator.fetch('https://publisher/sitemap/build', { method: 'POST' });
      await result.arrayBuffer();
      if (!result.ok) return new Response(null, { status: 503, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
    } else await publishSitemap(env);
    manifest = await readManifest(env);
  }
  if (!manifest) return new Response(null, { status: 503, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
  if (Date.now() - (manifest.checkedAt ?? manifest.builtAt) > 3_600_000 || manifest.rules !== ROBOTS_RULES_REVISION) ctx.waitUntil(bumpSitemap(env));
  const key = manifest.files[name];
  if (!key) return new Response(xmlDocument([]), { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=60' } });
  const object = await env.BUCKET.get(key);
  if (!object) return new Response(null, { status: 503, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
  const headers = new Headers({ 'cache-control': 'public, max-age=60', 'etag': object.httpEtag, 'x-content-type-options': 'nosniff' });
  object.writeHttpMetadata(headers);
  if (request.headers.get('if-none-match') === object.httpEtag || request.method === 'HEAD') {
    await object.body.cancel();
    return new Response(null, { status: request.headers.get('if-none-match') === object.httpEtag ? 304 : 200, headers });
  }
  return new Response(object.body, { headers });
}

export async function bumpSitemap(env: Partial<Bindings>): Promise<void> {
  if (!env.CACHE_PUBLISHER) return;
  const coordinator = env.CACHE_PUBLISHER.get(env.CACHE_PUBLISHER.idFromName('sitemap'));
  const response = await coordinator.fetch('https://publisher/sitemap/refresh', { method: 'POST' });
  await response.arrayBuffer();
}
