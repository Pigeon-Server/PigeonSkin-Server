// Hono 应用装配：中间件 + 路由挂载。
//
// 分层刻意保持浅：路由 → service 逻辑 → repository（Drizzle）。
// 没有 Laravel 那样的容器、Provider、Facade —— service 以参数接收依赖，
// 因此可以直接在测试和脚本里调用，不需要引导步骤。
import { Hono } from 'hono';
import { resolveConfiguration } from './services/configuration.ts';
import { registerPigeonApi } from './routes/pigeon-api.ts';
import { registerVoteRoutes } from './routes/votes.ts';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { authRoutes } from './routes/auth.ts';
import { securityAuthRoutes, securityMeRoutes } from './routes/security.ts';
import { playerRoutes } from './routes/players.ts';
import { textureRoutes } from './routes/textures.ts';
import { closetRoutes, reportRoutes } from './routes/social.ts';
import { adminRoutes, notificationRoutes } from './routes/admin.ts';
import { meRoutes } from './routes/me.ts';
import { createDb, users } from '@pigeon-skin/db';
import { eq } from 'drizzle-orm';
import { readPublic } from './services/settings.ts';
import { registerProtocolRoutes } from './routes/protocol.ts';
import { registerDerivativeRoutes } from './routes/derivatives.ts';
import { registerLegacyProtocolRoutes } from './routes/legacy-usm.ts';
import { registerOAuthRoutes } from './routes/oauth.ts';
import { registerMojangRoutes } from './routes/mojang.ts';
import { registerYggdrasilRoutes } from './routes/yggdrasil.ts';
import { registerConnectRoutes } from './routes/connect.ts';
import { OAuthError } from './services/connect.ts';
import { descriptionRoutes } from './routes/description.ts';
import { manualRoutes } from './routes/manual.ts';
import { manualAssetRoutes } from './routes/manual-assets.ts';
import { commentRoutes, commentAdminRoutes } from './routes/comments.ts';
import { restrictedEmailRoutes } from './routes/restricted-email.ts';
import { registerSitemapRoutes } from './routes/sitemap.ts';
import { siteManagementRoutes } from './routes/site-management.ts';
import { live2dRoutes } from './routes/live2d.ts';
import { integrationRoutes } from './routes/integrations.ts';
import { ticketRoutes } from './routes/tickets.ts';
import { csrfProtection, rateLimiter } from './middleware/security.ts';
import { oauthAuthentication, oauthCors } from './middleware/oauth.ts';
import { resolveSession, sessionToken, type AppEnv } from './lib.ts';
import { currentAdmin, toErrorResponse } from './framework.ts';
import {
  BANNED_ALLOWED_PATHS,
  INITIALIZATION_ALLOWED_PATHS,
  INITIALIZATION_PUBLIC_READ_PREFIXES,
} from './route-metadata.ts';
import { ensureDefaultCloset, ensureOfficialCatalog } from './services/official-catalog.ts';
import { renderSearchPage } from './services/seo.ts';
import { canonicalPagePath } from '@pigeon-skin/shared/seo';
import { flag } from './env.ts';

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    // 资产早退分支（补齐安全头）：非 HTML 资产直接透传；HTML 只放行编辑器
    // iframe（/blockbench/* 是自包含静态页，不参与 SPA SEO 预渲染），其余
    // HTML 继续走 notFound → renderSearchPage。
    if (c.env.ASSETS && ['GET', 'HEAD'].includes(c.req.method) && (/^\/(?:assets|fonts)\//.test(c.req.path) || /^\/manual-content(?:\.[\w-]+)?\.json$/.test(c.req.path) || /^\/manual\/[^/]+\.(?:jpg|png|webp)$/.test(c.req.path) || /^\/blockbench\//.test(c.req.path))) {
      const asset = await c.env.ASSETS.fetch(c.req.raw);
      if (!asset.headers.get('content-type')?.includes('text/html') || /^\/blockbench\//.test(c.req.path)) {
        const headers = new Headers(asset.headers);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('X-Frame-Options', 'SAMEORIGIN');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        headers.set('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
        return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
      }
    }
    await next();
  });
  app.use('*', async (c, next) => {
    if (c.req.path !== '/api/v1/health') c.env = await resolveConfiguration(c.env);
    await next();
  });

  // 结构化日志交给 Workers Logs；响应头做基本加固。
  // custom_js 是唯一有意允许执行脚本的地方，由后台设置控制，这里不放开 CSP。
  app.use('*', async (c, next) => {
    // 日志静默清单与 route-metadata 的 AUTH_RATE_LIMIT_PREFIXES 刻意不同
    // （限流要覆盖 /api/v1/auth/，日志静默只针对高频协议前缀），勿合并。
    if (c.req.path.startsWith('/yggc') || c.req.path.startsWith('/oauth') || c.req.path.startsWith('/auth/oauth') || c.req.path.startsWith('/api/v1/connect')) return next();
    return logger()(c, next);
  });
  app.use('*', async (c, next) => secureHeaders({
    xContentTypeOptions: 'nosniff',
    xFrameOptions: 'SAMEORIGIN',
    referrerPolicy: /^\/(?:yggc|oauth|auth\/oauth)(?:\/|$)/.test(c.req.path) ? 'no-referrer' : 'strict-origin-when-cross-origin',
  })(c, next));
  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  });
  app.use('*', async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/')) c.header('X-Robots-Tag', 'noindex');
    if (path.startsWith('/api/v1/') || path.startsWith('/api/yggdrasil')) return;
    const { getSettingBool } = await import('./lib.ts');
    if (await getSettingBool(c.env, 'ygg_enable_ali')) {
      c.header('X-Authlib-Injector-API-Location', `${c.env.APP_URL.replace(/\/$/, '')}/api/yggdrasil`);
    }
  });
  // 限流在最外层（越便宜的保护越靠外），CSRF 在会话解析之前。
  app.use('*', rateLimiter());
  app.use('*', oauthCors());
  app.use('*', csrfProtection());

  // 会话解析：把当前用户挂到 context 上。协议路由不需要它，
  // 但成本只有一次索引查询，且让所有路由的行为一致。
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/v1/') && c.req.header('authorization')) {
      return oauthAuthentication()(c, next);
    }
    const resolved = await resolveSession(c.env, sessionToken(c));
    c.set('user', resolved?.user ?? null);
    c.set('sessionId', resolved?.sessionId ?? null);

    // 被封禁的用户除登出与读取自身会话外一律拒绝。
    //
    // 这一步不能省：会话本身仍然有效，只是这个用户的角色变成了 banned。
    // 不检查的话，被封禁的人拿着旧 Cookie 仍能上传、改资料、收藏 —— 而"封禁"
    // 本该立即生效。旧版对应 RejectBannedUser 中间件，这里采用同一策略。
    if (resolved?.user.role === 'banned') {
      const path = new URL(c.req.url).pathname;
      if (!(BANNED_ALLOWED_PATHS as readonly string[]).includes(path)) return c.json({ error: 'auth.account_banned' }, 403);
    }
    if (resolved?.user.needsInitialization && c.req.path.startsWith('/api/v1/')) {
      const path = new URL(c.req.url).pathname;
      const allowed = (INITIALIZATION_ALLOWED_PATHS as readonly string[]).includes(path);
      const publicRead = c.req.method === 'GET' && (INITIALIZATION_PUBLIC_READ_PREFIXES as readonly string[]).some(prefix => path === prefix || path.startsWith(prefix + '/'));
      const preferences = path === '/api/v1/me/preferences' && c.req.method === 'PATCH';
      const security = path === '/api/v1/me/security' || path.startsWith('/api/v1/me/security/') || path === '/api/v1/auth/2fa' || path.startsWith('/api/v1/auth/2fa/') || (path === '/api/v1/me/oauth' && c.req.method === 'GET');
      if (!publicRead && !preferences && !security && !(allowed && (path !== '/api/v1/me' || c.req.method === 'GET'))) return c.json({ error: 'auth.initialization_required' }, 403);
    }

    await next();
  });

  // ── 健康检查 ───────────────────────────────────────────────────────────────
  app.use('/api/v1/*', async (c, next) => {
    const path = c.req.path;
    if (c.req.method === 'GET' && (path === '/api/v1/auth/session' || path === '/api/v1/me' || path === '/api/v1/closet' || path.startsWith('/api/v1/textures'))) {
      await ensureOfficialCatalog(c.env);
      const user = c.get('user');
      if (user && user.role !== 'banned') await ensureDefaultCloset(c.env, user.id);
    }
    await next();
  });

  // 探 D1 而不只是返回 200：一个不查依赖的健康检查会在数据库挂掉时继续报健康。
  app.get('/api/v1/health', async (c) => {
    const started = Date.now();
    let dbOk = false;
    let dbError: string | null = null;
    try {
      await c.env.DB.prepare('SELECT 1').first();
      dbOk = true;
    } catch (e) {
      dbError = String(e).slice(0, 200);
    }
    return c.json({
      ok: dbOk,
      environment: c.env.ENVIRONMENT,
      db: dbOk ? 'ok' : 'error',
      ...(dbError ? { dbError } : {}),
      latencyMs: Date.now() - started,
    }, dbOk ? 200 : 503);
  });

  app.route('/api/v1/auth', authRoutes);
  app.route('/api/v1/auth', securityAuthRoutes);
  app.route('/api/v1/me/security', securityMeRoutes);
  app.route('/api/v1/players', playerRoutes);
  app.route('/api/v1/textures', textureRoutes);
  app.route('/api/v1/closet', closetRoutes);
  app.route('/api/v1/reports', reportRoutes);
  app.route('/api/v1/tickets', ticketRoutes);
  // 公开设置：站名、注册开关、计费参数等前端启动时需要的值。
  // 用白名单裁剪，绝不把 custom_js、正则等内部配置暴露出去。
  app.get('/api/v1/settings/public', async (c) => {
    const locale = c.req.query('locale') ?? '';
    return c.json({ ...await readPublic(c.env, locale), turnstile_site_key: flag(c.env.TURNSTILE_ENABLED) ? c.env.TURNSTILE_SITE_KEY || '' : '' });
  });

  app.route('/api/v1/me', meRoutes);
  app.route('/api/v1/notifications', notificationRoutes);
  app.use('/api/v1/admin/*', async (c, next) => { currentAdmin(c); await next(); });
  app.route('/api/v1/admin', adminRoutes);
  // 纹理描述与评论区（挂在 textures 下需要独立子应用避免循环依赖）
  app.route('/api/v1', descriptionRoutes);
  app.route('/api/v1', manualRoutes);
  app.route('/api/v1', manualAssetRoutes);
  app.route('/api/v1', commentRoutes);
  app.route('/api/v1/admin', commentAdminRoutes);
  app.route('/api/v1', restrictedEmailRoutes);
  app.route('/api/v1', siteManagementRoutes);
  app.route('/api/v1', live2dRoutes);
  app.route('/api/v1', integrationRoutes);

  app.get('/api/v1/users/:id/avatar-url', async c => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.notFound();
    const [user] = await createDb(c.env.DB).select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) return c.notFound();
    return c.json({ url: `/avatar/user/${user.id}?mode=2d&size=100` });
  });

  // Minecraft 协议挂在根路径：/{player}.json、/textures/{hash} 等。
  // 这些路径由客户端协议固定，不能挪到 /api 下面。
  registerProtocolRoutes(app);

  // 不可变衍生图同样在根路径：/avatar/{hash}、/preview/{hash}。
  registerDerivativeRoutes(app);

  // 内置插件协议（根路径，客户端写死）：legacy-api、usm-api
  registerLegacyProtocolRoutes(app);
  // OAuth 社交登录 + 正版验证
  registerOAuthRoutes(app);
  registerMojangRoutes(app);
  // Yggdrasil 协议（authlib-injector 外置登录）
  registerYggdrasilRoutes(app);
  registerPigeonApi(app);
  registerVoteRoutes(app);
  registerConnectRoutes(app);
  // sitemap.xml / robots.txt 自动生成
  registerSitemapRoutes(app);

  // SPA 深链回退：/skinlib、/player 等前端路由没有对应资产文件名，
  // 资产层未命中落到这里 —— 返回 index.html；纯 API 路径仍回 JSON 404。
  app.notFound(async (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'common.not_found' }, 404);
    if (!c.env.ASSETS) return c.json({ error: 'common.not_found' }, 404);
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status === 200 && !asset.headers.get('content-type')?.includes('text/html')) return asset;
    if (asset.status === 200 && asset.headers.get('content-type')?.includes('text/html') && ['GET', 'HEAD'].includes(c.req.method)) {
      const path = c.req.path === '/index.html' ? '/' : canonicalPagePath(c.req.path);
      if (path !== c.req.path) return c.redirect(`${path}${new URL(c.req.url).search}`, 301);
      return renderSearchPage(asset, c.env, c.req.raw);
    }
    return c.json({ error: 'common.not_found' }, 404);
  });

  // 统一错误出口：AppError → 对应状态码，ZodError → 422 + 字段细节。
  // 路由里因此不需要 try/catch，service 里也用抛错表达业务失败。
  app.onError((err, c) => {
    if (err instanceof OAuthError) {
      c.header('Cache-Control', 'no-store');
      if (err.status === 401 || err.code === 'insufficient_scope') c.header('WWW-Authenticate', `Bearer error="${err.code}"`);
      return c.json({ error: err.code, error_description: err.message }, err.status);
    }
    return toErrorResponse(err, c);
  });

  return app;
}
