import { and, desc, eq } from 'drizzle-orm';
import { createDb, textures, texturesDescription } from '@pigeon-skin/db';
import { canonicalPagePath, defaultSiteDescription, indexablePage, pageCanonical, languageAlternates, plainDescription, type PageMetadata } from '@pigeon-skin/shared/seo';
import { localizedManualPages, renderManualContent, resolveManualDocuments, type ManualDocument } from '@pigeon-skin/shared/manual';
import { marked, Renderer } from 'marked';
import { readLocalized } from './settings.ts';
import { readManualDocuments } from './manual.ts';
import { normalizeLocale, localeTag, DEFAULT_LOCALE, LOCALES, type Locale } from '@pigeon-skin/shared/locales';
import { serviceTranslator } from './translations.ts';
import type { Bindings } from '../env.ts';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function safeUrl(value: string): string {
  try { return ['http:', 'https:'].includes(new URL(value, 'https://example.com').protocol) ? value : ''; } catch { return ''; }
}

export function renderSearchContent(content: string): string {
  const renderer = new Renderer();
  let section = 0;
  renderer.heading = function (token) {
    const id = token.depth === 2 ? ` id="section-${++section}"` : '';
    return `<h${token.depth}${id}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
  };
  renderer.html = () => '';
  renderer.link = function (token) {
    const label = this.parser.parseInline(token.tokens);
    const href = safeUrl(token.href);
    return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
  };
  renderer.image = token => {
    const src = safeUrl(token.href);
    return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}" loading="lazy">` : escapeHtml(token.text);
  };
  return marked.parse(content, { async: false, renderer }) as string;
}

export async function manualCatalog(env: Bindings, locale: Locale = DEFAULT_LOCALE, documents?: ManualDocument[]) {
  const manualPages = localizedManualPages(await serviceTranslator(env, locale));
  const items = resolveManualDocuments(documents ?? await readManualDocuments(env), locale);
  const pages = manualPages.map(page => ({ ...page, content: '', updatedAt: 0, locale, availableLocales: LOCALES as readonly Locale[] }));
  for (const document of items) {
    const page = { ...document, group: document.group || 'Custom documents', locale: document.locale || locale, availableLocales: document.availableLocales || LOCALES };
    const index = pages.findIndex(item => item.slug === document.slug);
    if (index >= 0) pages[index] = page; else pages.push(page);
  }
  return pages;
}

export async function searchPage(env: Bindings, requestUrl: string, locale: Locale = DEFAULT_LOCALE): Promise<{ metadata: PageMetadata; content: string; status: number }> {
  const request = new URL(requestUrl);
  const path = canonicalPagePath(request.pathname);
  const settings = await readLocalized(env, locale);
  const t = await serviceTranslator(env, locale);
  const siteName = settings.site_name || 'Pigeon Skin Server';
  const description = plainDescription(settings.meta_description || settings.site_description || t('seo.description') || defaultSiteDescription);
  const parameters = new URLSearchParams(request.search);
  if (locale !== DEFAULT_LOCALE) parameters.set('lang', locale); else parameters.delete('lang');
  const canonical = pageCanonical(env.APP_URL, path, parameters.toString());
  const metadata: PageMetadata = { locale, title: `${siteName} · ${t('seo.home')}`, description, canonical, indexable: indexablePage(path, request.search) };
  let content = '';
  let status = 200;
  const link = (href: string, title: string) => `<a href="${escapeHtml(href)}">${escapeHtml(title)}</a>`;
  const navigation = `<nav aria-label="站点导航">${link('/', siteName)} · ${link('/skinlib', t('seo.home'))} · ${link('/manual', t('manual.title'))}</nav>`;
  if (path === '/' || path === '/skinlib') {
    const requestedPage = request.searchParams.get('page');
    const validPage = requestedPage === null || (/^[1-9]\d*$/.test(requestedPage) && Number.isSafeInteger(Number(requestedPage)) && Number(requestedPage) <= 10000);
    const page = path === '/skinlib' && validPage ? Number(requestedPage || 1) : 1;
    const rows = await createDb(env.DB).select({ id: textures.id, name: textures.name }).from(textures).where(eq(textures.visibility, 'public')).orderBy(path === '/' ? desc(textures.likes) : desc(textures.createdAt), desc(textures.id)).limit(path === '/' ? 3 : 24).offset((page - 1) * 24);
    if (path === '/skinlib') {
      metadata.title = `${t('seo.library')}${page > 1 ? ` · ${t('seo.page', { page })}` : ''} · ${siteName}`;
      metadata.description = t('seo.library_description');
      if (!validPage || (page > 1 && !rows.length)) { status = 404; metadata.indexable = false; }
    }
    content = `<h1>${escapeHtml(path === '/' ? siteName : t('seo.library'))}</h1><p>${escapeHtml(metadata.description)}</p><ul>${rows.map(row => `<li>${link(`/skinlib/${row.id}`, row.name)}</li>`).join('')}</ul>`;
    if (path === '/skinlib') content += `<nav aria-label="分页">${page > 1 ? link(page === 2 ? '/skinlib' : `/skinlib?page=${page - 1}`, t('common.prev')) : ''} ${rows.length === 24 ? link(`/skinlib?page=${page + 1}`, t('common.next')) : ''}</nav>`;
    else content += `<h2>${escapeHtml(t('seo.game_setup'))}</h2><p>${link('/manual/quick-start', t('seo.quick_start'))} · ${link('/manual/customskinloader', t('seo.csl'))} · ${link('/manual/yggdrasil', t('seo.yggdrasil'))}</p>`;
  } else if (path === '/manual' || path.startsWith('/manual/')) {
    const pages = await manualCatalog(env, locale);
    const slug = path === '/manual' ? '' : path.slice('/manual/'.length);
    const page = pages.find(page => page.slug === slug);
    if (!page) { status = 404; metadata.indexable = false; }
    else {
      metadata.title = `${page.title} · ${siteName}`;
      metadata.alternateLocales = page.availableLocales;
      metadata.description = plainDescription(page.description);
      let source = page.content;
      if (!page.updatedAt) {
        for (const assetPath of [locale === DEFAULT_LOCALE ? '/manual-content.json' : `/manual-content.${locale}.json`, '/manual-content.en.json']) {
          const asset = await env.ASSETS.fetch(new URL(assetPath, request));
          if (asset.ok && asset.headers.get('content-type')?.includes('application/json')) {
            const sources = await asset.json<Record<string, string>>();
            const content = sources[slug || 'welcome'];
            if (typeof content === 'string' && content) { source = content; break; }
          }
        }
      }
      if (!source) metadata.indexable = false;
      content = `<article lang="${localeTag(page.locale)}"><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.description)}</p>${renderSearchContent(renderManualContent(source, env.APP_URL, siteName))}</article><nav aria-label="用户手册"><ul>${pages.map(page => `<li>${link(`/manual${page.slug ? `/${page.slug}` : ''}`, page.title)}</li>`).join('')}</ul></nav>`;
      metadata.structuredData = [{ '@type': 'TechArticle', headline: page.title, description: metadata.description, url: canonical, inLanguage: localeTag(page.locale), ...(page.updatedAt ? { dateModified: new Date(page.updatedAt).toISOString() } : {}) }];
    }
  } else if (/^\/skinlib\/[1-9]\d*$/.test(path)) {
    const db = createDb(env.DB);
    const [texture] = await db.select().from(textures).where(and(eq(textures.id, Number(path.split('/').at(-1))), eq(textures.visibility, 'public'))).limit(1);
    if (!texture) {
      metadata.indexable = false;
      const [existing] = await db.select({ id: textures.id }).from(textures).where(eq(textures.id, Number(path.split('/').at(-1)))).limit(1);
      if (!existing) status = 404;
      // 存在但非 public：与前端 Show.vue 的 noindex 展示一致，用"找不到"占位
      else metadata.title = `${t('common.not_found')} · ${siteName}`;
    }
    else {
      const [detail] = await db.select().from(texturesDescription).where(eq(texturesDescription.tid, texture.id)).limit(1);
      const kind = t(texture.kind === 'cape' ? 'general.cape' : 'general.skin');
      metadata.title = `${texture.name} · Minecraft ${kind} · ${siteName}`;
      metadata.description = plainDescription(detail?.description || t('seo.texture_description', { name: texture.name, kind, width: texture.width, height: texture.height }));
      metadata.image = new URL(`/preview/${texture.hash}`, env.APP_URL).href;
      content = `<article><h1>${escapeHtml(texture.name)}</h1><p>Minecraft ${kind} · ${texture.width} × ${texture.height}${texture.kind === 'skin' ? ` · ${t(texture.model === 'slim' ? 'skinlib.model_slim' : 'skinlib.model_classic')}` : ''}</p><img src="${escapeHtml(metadata.image)}" alt="${escapeHtml(texture.name)}"><div>${renderSearchContent(detail?.description || '')}</div></article>`;
      metadata.structuredData = [{ '@type': 'CreativeWork', name: texture.name, description: metadata.description, url: canonical, image: metadata.image, datePublished: new Date(texture.createdAt).toISOString(), dateModified: new Date(texture.updatedAt).toISOString() }];
    }
  } else if (!/^\/(?:admin|user|player|closet|profile|reports|votes|connect|auth)(?:\/|$)/.test(path) && !['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/setup', '/connections', '/.well-known/change-password'].includes(path)) {
    status = 404;
    metadata.indexable = false;
  }
  if (status === 404) { metadata.title = `${t('common.not_found')} · ${siteName}`; content = `<h1>${escapeHtml(t('common.not_found'))}</h1>`; }
  if (!metadata.indexable) metadata.structuredData = [];
  else metadata.structuredData = [
    { '@type': 'WebSite', '@id': `${env.APP_URL}/#website`, name: siteName, url: `${env.APP_URL}/` },
    ...(metadata.structuredData || [{ '@type': path === '/skinlib' ? 'CollectionPage' : 'WebPage', name: metadata.title, description: metadata.description, url: canonical }]),
    ...(path === '/' ? [] : [{ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: siteName, item: `${env.APP_URL}/` }, ...(path.startsWith('/skinlib/') ? [{ '@type': 'ListItem', position: 2, name: t('general.skinlib'), item: `${env.APP_URL}/skinlib` }] : path.startsWith('/manual/') ? [{ '@type': 'ListItem', position: 2, name: t('manual.title'), item: `${env.APP_URL}/manual` }] : []), { '@type': 'ListItem', position: path.startsWith('/skinlib/') || path.startsWith('/manual/') ? 3 : 2, name: metadata.title.split(' · ')[0], item: canonical }] }]),
  ];
  return { metadata, content: content ? `<main>${navigation}${content}</main>` : '', status };
}

export async function renderSearchPage(asset: Response, env: Bindings, request: Request): Promise<Response> {
  const cookie = /(?:^|;\s*)locale=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1];
  const locale = normalizeLocale(new URL(request.url).searchParams.get('lang') || cookie || request.headers.get('accept-language')?.split(',')[0]?.split(';')[0]);
  const { metadata, content, status } = await searchPage(env, request.url, locale);
  const graph = JSON.stringify({ '@context': 'https://schema.org', '@graph': metadata.structuredData || [] }).replace(/</g, '\\u003c');
  const alternates = metadata.indexable ? languageAlternates(metadata.canonical).filter(alternate => !metadata.alternateLocales || metadata.alternateLocales.some(locale => localeTag(locale) === alternate.tag) || (alternate.tag === 'x-default' && metadata.alternateLocales.includes(DEFAULT_LOCALE))).map(alternate => `<link rel="alternate" hreflang="${alternate.tag}" href="${escapeHtml(alternate.href)}">`).join('') : '';
  const tags = `${alternates}${content ? '<style>html[data-seo-fallback] #app{visibility:hidden}</style><script>document.documentElement.setAttribute(\'data-seo-fallback\',\'\');</script>' : ''}<meta name="description" content="${escapeHtml(metadata.description)}"><meta name="robots" content="${metadata.indexable ? 'index,follow,max-image-preview:large' : 'noindex,follow'}"><link rel="canonical" href="${escapeHtml(metadata.canonical)}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(metadata.title)}"><meta property="og:description" content="${escapeHtml(metadata.description)}"><meta property="og:url" content="${escapeHtml(metadata.canonical)}">${metadata.image ? `<meta property="og:image" content="${escapeHtml(metadata.image)}">` : ''}<meta name="twitter:card" content="${metadata.image ? 'summary_large_image' : 'summary'}"><script id="page-structured-data" type="application/ld+json">${graph}</script>`;
  const response = new Response(asset.body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-cache', 'Content-Language': localeTag(locale), ...(metadata.indexable ? {} : { 'X-Robots-Tag': 'noindex, follow' }) } });
  return new HTMLRewriter().on('html', { element(element) { element.setAttribute('lang', localeTag(locale)); } }).on('title', { element(element) { element.setInnerContent(metadata.title); } }).on('head', { element(element) { element.append(tags, { html: true }); } }).on('#app', { element(element) { element.setInnerContent(content, { html: true }); } }).transform(response);
}
