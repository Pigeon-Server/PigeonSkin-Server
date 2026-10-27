import { Hono } from 'hono';
import type { AppEnv } from '../../core/user.ts';
import { searchConfiguration } from '../../services/search-submissions.ts';

export function registerSitemapRoutes(app: Hono<AppEnv>): void {
  app.get('/:keyFile', async (c, next) => {
    if (!/^[a-zA-Z0-9-]{8,128}\.txt$/.test(c.req.param('keyFile'))) return next();
    const { values } = await searchConfiguration(c.env);
    const key = values.search_bing_key;
    if (!key || values.search_bing_enabled !== 'true' || c.req.param('keyFile') !== `${key}.txt`) return next();
    c.header('Cache-Control', 'no-store');
    return c.text(key);
  });
}
