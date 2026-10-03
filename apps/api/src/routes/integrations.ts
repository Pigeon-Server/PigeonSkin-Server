import { Hono } from 'hono';
import { currentAdmin, currentUser, readPagination, paginate, fail } from '../framework.ts';
import { searchConfiguration, searchSubmissionStatus, queuePublicSubmissions } from '../services/search-submissions.ts';
import { createSkinConfigs } from '@pigeon-skin/shared/skin-config';
import { readPublic } from '../services/settings.ts';
import { getSetting, type AppEnv } from '../lib.ts';
import { inspectSigningKey } from '../services/ygg-key.ts';
import { audit } from '../services/audit.ts';
import { officialResourceStatus, syncOfficialResources } from '../services/official-updates.ts';
import { normalizeLocale } from '@pigeon-skin/shared/i18n';

export const integrationRoutes = new Hono<AppEnv>();
integrationRoutes.get('/admin/official-resources', async c => {
  currentAdmin(c);
  return c.json(await officialResourceStatus(c.env));
});
integrationRoutes.post('/admin/official-resources/sync', async c => {
  currentAdmin(c);
  return c.json(await syncOfficialResources(c.env, true), 202);
});

integrationRoutes.get('/admin/search-submissions', async (c) => {
  currentAdmin(c);
  return c.json(await searchSubmissionStatus(c.env));
});

integrationRoutes.post('/admin/search-submissions', async (c) => {
  const actor = currentAdmin(c);
  if (actor.role !== 'super_admin') throw fail.forbidden();
  const { root, values } = await searchConfiguration(c.env);
  if (!root || !['google', 'bing', 'baidu'].some(engine => values[`search_${engine}_enabled`] === 'true')) throw fail.invalid();
  const queued = await queuePublicSubmissions(c.env);
  await audit(c.env, { actorId: actor.id, action: 'admin.search.submit', detail: `queued:${queued}` });
  return c.json({ queued }, 202);
});

integrationRoutes.get('/config/extra-list', async (c) => {
  currentUser(c);
  const settings = await readPublic(c.env, normalizeLocale(c.req.query('locale')));
  const name = settings.site_name || 'Pigeon Skin Server';
  const configuration = createSkinConfigs(name, c.env.APP_URL, settings.csl_first === 'mojang' ? 'mojang' : 'self');
  const filename = name.replace(/[<>:"/\\|?*]/g, '_').replace(/\p{Cc}/gu, '_') + '.json';
  c.header('Content-Disposition', `attachment; filename="skin-server.json"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  c.header('Content-Type', 'application/json; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  return c.body(JSON.stringify(configuration.extraList));
});

integrationRoutes.get('/admin/integrations', async (c) => {
  currentAdmin(c);
  const root = c.env.APP_URL.replace(/\/$/, '');
  const providers = [
    {
      id: 'github',
      clientId: !!c.env.GITHUB_CLIENT_ID,
      clientSecret: !!c.env.GITHUB_CLIENT_SECRET,
    },
    {
      id: 'littleskin',
      clientId: !!c.env.LITTLESKIN_CLIENT_ID,
      clientSecret: !!c.env.LITTLESKIN_CLIENT_SECRET,
    },
    {
      id: 'microsoft',
      clientId: !!c.env.MICROSOFT_CLIENT_ID,
      clientSecret: !!c.env.MICROSOFT_CLIENT_SECRET,
    },
  ].map((provider) => ({
    ...provider,
    configured: provider.clientId && provider.clientSecret,
    callbackUrl: `${root}/auth/oauth/${provider.id}/callback`,
  }));
  return c.json({
    apiRoot: `${root}/api/yggdrasil`,
    providers,
    mojang: {
      configured:
        (c.env.MOJANG_CLIENT_ID || c.env.MOJANG_CLIENT_SECRET) ? !!(c.env.MOJANG_CLIENT_ID && c.env.MOJANG_CLIENT_SECRET) : !!(c.env.MICROSOFT_CLIENT_ID && c.env.MICROSOFT_CLIENT_SECRET),
      callbackUrl: `${root}/mojang/callback`,
      usesMicrosoft: !(c.env.MOJANG_CLIENT_ID || c.env.MOJANG_CLIENT_SECRET),
    },
    signingKey: await inspectSigningKey(await getSetting(c.env, 'ygg_private_key')),
  });
});

integrationRoutes.get('/admin/yggdrasil/logs', async (c) => {
  currentAdmin(c);
  const page = readPagination(c);
  const action = c.req.query('action') || '';
  const total = await c.env.DB.prepare(
    "SELECT count(*) AS n FROM ygg_log WHERE (? = '' OR action = ?)",
  )
    .bind(action, action)
    .first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    "SELECT id, ip, action, body, user_id AS userId, player_id AS playerId, created_at AS createdAt FROM ygg_log WHERE (? = '' OR action = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
  )
    .bind(action, action, page.perPage, page.offset)
    .all<{
      id: number;
      ip: string | null;
      action: string;
      body: string | null;
      userId: number | null;
      playerId: number | null;
      createdAt: number;
    }>();
  return c.json(paginate(results, total?.n ?? 0, page));
});
