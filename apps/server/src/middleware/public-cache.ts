import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../core/user.ts';
import { readPublicCache } from '../core/public-cache.ts';
import { normalizeLocale } from '@pigeon-skin/shared/locales';
import { clientIp } from '../core/ip.ts';

/**
 * 构建产物标识（每个 isolate 计算一次）。
 *
 * 整页 HTML 里引用带内容哈希的 bundle 名，而 HTML 缓存在共享 KV 里、版本号只看
 * 内容作用域 —— 前端重新部署不会改动任何 scope 版本。不把构建标识纳入缓存键，
 * 部署后 KV 里的旧 HTML 会长期指向已删除的 bundle，SPA 直接白屏。
 */
let buildTag: Promise<string> | null = null;
function currentBuildTag(env: AppEnv['Bindings']): Promise<string> {
  buildTag ??= (async () => {
    try {
      const index = await env.ASSETS.fetch(new Request('https://assets/index.html'));
      if (!index.ok) return 'unknown';
      const html = await index.text();
      // bundle 名里的内容哈希就是构建标识；取不到就退化为整页哈希
      const bundle = /assets\/index-([A-Za-z0-9_-]+)\.js/.exec(html)?.[1];
      if (bundle) return bundle;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html));
      return [...new Uint8Array(digest)].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return 'unknown';
    }
  })();
  return buildTag;
}

export function publicResponseCache(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.env.PUBLIC_CACHE || c.req.header('authorization') || c.req.method !== 'GET') return next();
    const url = new URL(c.req.url), path = url.pathname;
    let scopes: string[];
    if (path === '/api/v1/settings/public' || path === '/api/v1/live2d') scopes = ['settings'];
    else if (path === '/api/v1/manual') scopes = ['manual', 'settings'];
    else if (path === '/api/v1/translations') scopes = ['translations'];
    else if (/^\/(?:yggc\/)?\.well-known\/(?:openid-configuration|oauth-authorization-server)(?:\/yggc)?$/.test(path) || path === '/yggc/jwks') scopes = ['discovery', 'settings'];
    else if (path === '/' || path === '/manual' || path.startsWith('/manual/')) scopes = ['manual', 'translations', 'settings', ...(path === '/' ? ['textures'] : [])];
    else return next();
    if ([...url.searchParams.keys()].some(key => !['locale', 'lang'].includes(key))) return next();
    if ([...url.searchParams.values()].some(value => value && !['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU', 'ja_JP'].includes(value))) return next();
    if (c.env.RATE_LIMIT_ENABLED !== 'false' && c.env.RL_GLOBAL) {
      try { if (!(await c.env.RL_GLOBAL.limit({ key: `api:${clientIp(c)}` })).success) return c.json({ error: 'common.rate_limited' }, 429, { 'Retry-After': '60' }); } catch {}
    }
    // HTML 页面的语言只由 `lang`/Cookie/Accept-Language 决定（seo.ts 的渲染同口径，
    // 不读 `locale` 查询参数）。缓存键必须与渲染读同一组输入，否则 `?locale=en`
    // 会用中文正文生成页面却写进 en 键，之后所有 en 请求都拿到中文。
    // Accept-Language 要去掉权重后缀（`ja;q=0.9`），否则 normalizeLocale 会落到默认语言。
    const fromQuery = url.searchParams.get('lang');
    const fromCookie = /(?:^|;\s*)locale=([^;]+)/.exec(c.req.header('cookie') || '')?.[1];
    const fromHeader = c.req.header('accept-language')?.split(',')[0]?.split(';')[0]?.trim();
    const locale = normalizeLocale(fromQuery || fromCookie || fromHeader);
    const localeKey = path.startsWith('/api/') ? JSON.stringify([url.searchParams.get('locale'), url.searchParams.get('lang')]) : locale;
    // HTML 页面额外带构建标识：部署换了 bundle 就换键，旧页面自然失效
    const key = path.startsWith('/api/')
      ? `response:${path}:${localeKey}`
      : `response:${path}:${localeKey}:${await currentBuildTag(c.env)}`;
    try {
      const result = await readPublicCache(c.env, key, scopes, async () => {
        await next();
        if (![200, 302].includes(c.res.status) || c.res.headers.has('set-cookie')) throw c.res;
        const headers = new Headers(c.res.headers);
        headers.set('cache-control', 'public, max-age=60');
        headers.set('vary', 'Accept-Language, Cookie');
        return { status: c.res.status, headers: [...headers], body: await c.res.clone().text() };
      }, 300_000, false);
      return new Response(result.body, { status: result.status, headers: result.headers });
    } catch (error) { if (error instanceof Response) return error; throw error; }
  };
}
