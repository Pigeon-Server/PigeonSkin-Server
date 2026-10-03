// sitemap.xml 与 robots.txt 自动生成。
//
// 机制（用户需求：后台自动生成/自动更新）：
//   • 读取时构建：D1 查询公开纹理 + 玩家列表，按 sitemap 协议分片（每片 ≤5 万 URL），
//     sitemap index 聚合。结果进 Cache API 缓存 60 分钟。
//   • 主动失效：纹理/玩家/设置的写路径调用 bumpSitemap() 递增 Cache API 里的
//     版本号（存储在另一个 cache key），下次读取即重建 —— cron 只兜底
//     （每天重建一次，防止失效调用遗漏导致的漂移）。
//   • URL 集合：/ （首页）、/skinlib（列表页）、/skinlib/:id（仅 public 纹理，
//     上限 sitemap_max_urls 设置，默认 20000，防超大站打爆 D1）、认证页。
//   • robots.txt：Allow 全站、Disallow /api /admin /raw /textures（字节无意义），
//     Sitemap 指向 index。
//
// 不引入 KV/DO：版本号与缓存都在 Cache API（同一 colo 语义足够，
// 跨 colo 少量陈旧 sitemap 对 SEO 无影响）。

import { Hono } from 'hono';
import type { Context } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { createDb, textures } from '@pigeon-skin/db';
import { getSettingInt, getSettingBool, type AppEnv } from '../lib.ts';
import { searchConfiguration } from '../services/search-submissions.ts';
import { manualCatalog } from '../services/seo.ts';
import { readManualDocuments } from '../services/manual.ts';
import { LOCALES, DEFAULT_LOCALE } from '@pigeon-skin/shared/locales';
import { ROBOTS_API_RULES, ROBOTS_PROTOCOL_DISALLOW } from '../route-metadata.ts';

type Ctx = Context<AppEnv>;

const CACHE_TTL_SECONDS = 60 * 60;
const SITEMAP_CACHE_PREFIX = 'https://sitemap.internal/';
const VERSION_KEY = 'https://sitemap.internal/__version__';
/** 单个 sitemap 分片的 URL 上限（协议硬限制 5 万，这里取一半留余量） */
const URLS_PER_CHUNK = 25_000;

/** 版本号：写入路径 bump，读取路径带上 —— bump 后旧缓存自然失效 */
/** 预留 c 参数：未来按 env 差异化缓存键时使用 */
async function currentVersion(_c?: unknown): Promise<number> {
  const cache = caches.default;
  const hit = await cache.match(VERSION_KEY);
  if (hit) return Number((await hit.text()) || '1');
  return 1;
}

interface SitemapUrls {
  staticUrls: string[];
  manualUrls: Array<{ loc: string; updatedAt: number }>;
  textureIds: Array<{ id: number; updatedAt: number }>;
}

async function collectUrls(c: Ctx): Promise<SitemapUrls> {
  const db = createDb(c.env.DB);
  const maxUrls = await getSettingInt(c.env, 'sitemap_max_urls');

  const textureRows = await db
    .select({ id: textures.id, updatedAt: textures.updatedAt })
    .from(textures)
    .where(eq(textures.visibility, 'public'))
    .orderBy(desc(textures.updatedAt))
    .limit(Math.min(maxUrls, 50_000));

  const appUrl = c.env.APP_URL.replace(/\/$/, '');
  const documents = await readManualDocuments(c.env);
  const catalogs = await Promise.all(LOCALES.map(async locale => ({ locale, pages: await manualCatalog(c.env, locale, documents) })));
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

async function cachedResponse(
  c: Ctx, cacheKey: string, version: number,
  build: () => Promise<{ body: string; contentType: string }>,
): Promise<Response> {
  const cache = caches.default;
  const keyed = new Request(`${cacheKey}?v=${version}`, { method: 'GET' });
  const hit = await cache.match(keyed);
  if (hit) {
    // clone：Cache API 返回的 body 流只能读一次，响应还可能被
    // 上层/测试再次消费
    return new Response(hit.body, { headers: new Headers(hit.headers) });
  }

  const { body, contentType } = await build();
  const response = new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
  c.executionCtx.waitUntil(cache.put(keyed, response.clone()));
  return response;
}

export function registerSitemapRoutes(app: Hono<AppEnv>): void {
  app.get('/:keyFile', async (c, next) => {
    if (!/^[a-zA-Z0-9-]{8,128}\.txt$/.test(c.req.param('keyFile'))) return next();
    const { values } = await searchConfiguration(c.env);
    const key = values.search_bing_key;
    if (!key || values.search_bing_enabled !== 'true' || c.req.param('keyFile') !== `${key}.txt`) return next();
    c.header('Cache-Control', 'no-store');
    return c.text(key);
  });
  const handler = (kind: 'index' | 'robots') => async (c: Ctx) => {
    const version = await currentVersion();
    const appUrl = c.env.APP_URL.replace(/\/$/, '');
    return cachedResponse(c, `${SITEMAP_CACHE_PREFIX}${encodeURIComponent(appUrl)}/${kind}`, version, async () => {
      if (kind === 'robots') {
        const allowDownload = await getSettingBool(c.env, 'allow_texture_download');
        const body = [
          'User-agent: *',
          ...ROBOTS_API_RULES,
          ...ROBOTS_PROTOCOL_DISALLOW,
          'Disallow: /manual-content.json',
          ...(allowDownload ? [] : ['Disallow: /usm/textures/', 'Disallow: /skin/']),
          '',
          `Sitemap: ${appUrl}/sitemap.xml`,
          '',
        ].join('\n');
        return { body, contentType: 'text/plain; charset=utf-8' };
      }

      const urls = await collectUrls(c);
      const chunks = buildChunks(urls, appUrl);
      // 单分片（绝大多数站点）直接输出 sitemap.xml；多分片输出 sitemap index
      if (chunks.length === 1) {
        const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${chunks[0]!.join('\n')}\n</urlset>\n`;
        return { body, contentType: 'application/xml; charset=utf-8' };
      }
      const entries = chunks.map((_, i) =>
        `  <sitemap><loc>${xmlEscape(appUrl)}/sitemap-${i + 1}.xml</loc></sitemap>`);
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</sitemapindex>\n`;
      return { body, contentType: 'application/xml; charset=utf-8' };
    });
  };

  // 分片端点：/sitemap-N.xml。
  // 不用 Hono 的 '/sitemap-:n.xml' 语法 —— 参数后跟字面后缀匹配不到请求
  // （与 protocol.ts 的 /{player}.json 同一个坑），改为匹配单段自解析
  app.get('/:file', async (c, next) => {
    const file = c.req.param('file') ?? '';
    const m = /^sitemap-(\d+)\.xml$/.exec(file);
    if (!m) return next();
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1) return c.notFound();
    const version = await currentVersion();
    const appUrl = c.env.APP_URL.replace(/\/$/, '');
    return cachedResponse(c, `${SITEMAP_CACHE_PREFIX}${encodeURIComponent(appUrl)}/chunk-${n}`, version, async () => {
      const urls = await collectUrls(c);
      const chunks = buildChunks(urls, appUrl);
      const idx = n - 1;
      // 越界分片返回空 urlset（而不是 404）：build 回调不返回 Response，
      // 避免 404 响应体绕过缓存路径后悬空（pool-workers 会因此挂起后续测试）
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${(chunks[idx] ?? []).join('\n')}\n</urlset>\n`;
      return { body, contentType: 'application/xml; charset=utf-8' };
    });
  });

  app.get('/sitemap.xml', handler('index'));
  app.get('/robots.txt', handler('robots'));
}
