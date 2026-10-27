import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../core/user.ts';
import { readPublicCache } from '../core/public-cache.ts';
import { normalizeLocale } from '@pigeon-skin/shared/locales';
import { clientIp } from '../core/ip.ts';

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
    const locale = normalizeLocale(url.searchParams.get('locale') || url.searchParams.get('lang') || /(?:^|;\s*)locale=([^;]+)/.exec(c.req.header('cookie') || '')?.[1] || c.req.header('accept-language')?.split(',')[0]);
    const localeKey = path.startsWith('/api/') ? JSON.stringify([url.searchParams.get('locale'), url.searchParams.get('lang')]) : locale;
    const key = `response:${path}:${localeKey}`;
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
