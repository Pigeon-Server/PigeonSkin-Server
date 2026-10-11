// Hono 应用装配：中间件 + 路由挂载。
//
// 分层刻意保持浅：路由 → service 逻辑 → repository（Drizzle）。
// 没有 Laravel 那样的容器、Provider、Facade —— service 以参数接收依赖，
// 因此可以直接在测试和脚本里调用，不需要引导步骤。
import { currentAdmin, toErrorResponse } from './core/framework.ts';
import { getSettingBool } from './core/settings-reader.ts';
import { type AppEnv } from './core/user.ts';
import { Hono } from 'hono';
import { resolveConfiguration } from './services/configuration.ts';
import { registerPigeonApi } from './routes/admin/pigeon-api.ts';
import { registerPigeonAdminApi } from './routes/admin/pigeon-admin.ts';
import { registerVoteRoutes } from './routes/content/votes.ts';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { authRoutes } from './routes/auth/auth.ts';
import { securityAuthRoutes, securityMeRoutes } from './routes/auth/security.ts';
import { playerRoutes } from './routes/content/players.ts';
import { textureRoutes } from './routes/content/textures.ts';
import { closetRoutes, reportRoutes } from './routes/content/social.ts';
import { adminRoutes, notificationRoutes } from './routes/admin/admin.ts';
import { meRoutes } from './routes/account/me.ts';
import { createDb, users } from '@pigeon-skin/db';
import { eq } from 'drizzle-orm';
import { readPublic } from './services/settings.ts';
import { registerProtocolRoutes } from './routes/protocol/protocol.ts';
import { registerDerivativeRoutes } from './routes/protocol/derivatives.ts';
import { registerLegacyProtocolRoutes } from './routes/protocol/legacy-usm.ts';
import { registerOAuthRoutes } from './routes/auth/oauth.ts';
import { registerMojangRoutes } from './routes/auth/mojang.ts';
import { registerYggdrasilRoutes } from './routes/protocol/yggdrasil.ts';
import { registerConnectRoutes } from './routes/protocol/connect.ts';
import { OAuthError } from './services/connect.ts';
import { descriptionRoutes } from './routes/content/description.ts';
import { usersRoutes } from './routes/content/users.ts';
import { deviceRoutes } from './routes/auth/devices.ts';
import { manualRoutes } from './routes/content/manual.ts';
import { manualAssetRoutes } from './routes/content/manual-assets.ts';
import { commentRoutes, commentAdminRoutes } from './routes/content/comments.ts';
import { restrictedEmailRoutes } from './routes/admin/restricted-email.ts';
import { registerSitemapRoutes } from './routes/admin/sitemap.ts';
import { siteManagementRoutes } from './routes/admin/site-management.ts';
import { live2dRoutes } from './routes/admin/live2d.ts';
import { integrationRoutes } from './routes/admin/integrations.ts';
import { ticketRoutes } from './routes/content/tickets.ts';
import { blockedCrawlerGuard, csrfProtection, rateLimiter } from './middleware/security.ts';
import { skinlibGuard } from './middleware/skinlib-guard.ts';
import { oauthCors } from './middleware/oauth.ts';
import { bearerAuthentication } from './middleware/bearer.ts';

import { ensureDefaultCloset, ensureOfficialCatalog } from './services/official-catalog.ts';
import { renderSearchPage } from './services/seo.ts';
import { canonicalPagePath } from '@pigeon-skin/shared/seo';
import { isCaptchaEnabled } from './services/captcha.ts';

export function createApp() {
  const app = new Hono<AppEnv>();
  // 被禁抓取代理最先拦掉：只比较一个请求头，比配置解析、限流、会话都便宜。
  // 纯静态文件（hashed 产物、blockbench、live2d 模型、手册截图等）由资产层
  // 直接服务、不进 Worker（见 wrangler.jsonc run_worker_first），其安全头与
  // 缓存声明在 web/public/_headers。
  app.use('*', blockedCrawlerGuard());
  app.use('*', async (c, next) => {
    if (c.req.path !== '/api/v1/health') c.env = await resolveConfiguration(c.env);
    await next();
  });

  // 结构化请求日志交给 Workers Logs（invocation log + traces）；hono 的
  // console 输出在平台上与 invocation log 重复、还会多耗日志事件额度，
  // 只在本地开发补请求级可读输出。
  // 日志静默清单与 route-metadata 的 AUTH_RATE_LIMIT_PREFIXES 刻意不同
  // （限流要覆盖 /api/v1/auth/，日志静默只针对高频协议前缀），勿合并。
  app.use('*', async (c, next) => {
    if (c.env.ENVIRONMENT !== 'development') return next();
    if (c.req.path.startsWith('/yggc') || c.req.path.startsWith('/oauth') || c.req.path.startsWith('/auth/oauth') || c.req.path.startsWith('/api/v1/connect')) return next();
    return logger()(c, next);
  });
  app.use('*', async (c, next) => secureHeaders({
    xContentTypeOptions: 'nosniff',
    xFrameOptions: 'SAMEORIGIN',
    referrerPolicy: /^\/(?:yggc|oauth|auth\/oauth)(?:\/|$)/.test(c.req.path) ? 'no-referrer' : 'strict-origin-when-cross-origin',
  })(c, next));
  // custom_js 是唯一有意允许执行脚本的地方，由后台设置控制，CSP 不收紧脚本源。
  app.use('*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
  });
  app.use('*', async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/')) c.header('X-Robots-Tag', 'noindex');
    if (path.startsWith('/api/v1/') || path.startsWith('/api/yggdrasil')) return;
    if (await getSettingBool(c.env, 'ygg_enable_ali')) {
      c.header('X-Authlib-Injector-API-Location', `${c.env.APP_URL.replace(/\/$/, '')}/api/yggdrasil`);
    }
  });
  // 限流在最外层（越便宜的保护越靠外），CSRF 在会话解析之前。
  app.use('*', rateLimiter());
  app.use('*', oauthCors());
  app.use('*', csrfProtection());

  // 认证：把当前用户挂到 context 上。
  //
  // Web 前端凭 Authorization: Bearer <access JWT> 自证，验签本地完成；
  // 撤销/封禁等强一致语义经 isolate 缓存查 sessions 行（middleware/bearer.ts）。
  // 没有 Authorization 的请求（匿名、协议路由、SPA 静态页）不再查库。
  app.use('*', bearerAuthentication());

  // 皮肤库反爬守卫：会话已解析（登录用户按账号计数、匿名按 IP），
  // 放在官方目录补齐之前，被拦的请求不再触发后续 DB 工作。
  //
  // 按路由模式挂载而不是自己解析路径：正则只认 \d+，而路由用 Number() 解析
  // 参数（/0x47F、/+1151、/%311151 都会被路由接受），自解析会漏掉这些变体，
  // 形成"换个写法就绕过计数"的缺口。挂载点与路由共用同一套匹配语义。
  app.use('/api/v1/textures', skinlibGuard());
  app.use('/api/v1/textures/:id', skinlibGuard());
  app.use('/api/v1/textures/:id/description', skinlibGuard());

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
  app.route('/api/v1/me', deviceRoutes);
  app.route('/api/v1/players', playerRoutes);
  app.route('/api/v1/textures', textureRoutes);
  app.route('/api/v1/closet', closetRoutes);
  app.route('/api/v1/reports', reportRoutes);
  app.route('/api/v1/tickets', ticketRoutes);
  // 公开设置：站名、注册开关、计费参数等前端启动时需要的值。
  // 用白名单裁剪，绝不把 custom_js、正则等内部配置暴露出去。
  // 验证码驱动启用时下发 site key（Turnstile/reCAPTCHA/腾讯 AppId/阿里 SceneId），供前端渲染 widget。
  app.get('/api/v1/settings/public', async (c) => {
    const locale = c.req.query('locale') ?? '';
    const enabled = isCaptchaEnabled(c.env);
    return c.json({
      ...await readPublic(c.env, locale),
      captcha_driver: enabled ? c.env.CAPTCHA_DRIVER : '',
      captcha_site_key: enabled ? c.env.CAPTCHA_SITE_KEY || '' : '',
    });
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

  // 公开用户资料（创作者主页）
  app.route('/api/v1', usersRoutes);

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
  registerPigeonAdminApi(app);
  registerVoteRoutes(app);
  registerConnectRoutes(app);
  // sitemap.xml / robots.txt 自动生成
  registerSitemapRoutes(app);

  // SPA 深链回退：/skinlib、/player 等前端路由没有对应资产文件名。先按原
  // 路径问一次资产层 —— Node 自托管的静态文件全部经这里透传（Workers 上
  // 纯静态文件不进 Worker，见 wrangler.jsonc run_worker_first）；未命中再
  // 显式取 index.html 做 SEO 预渲染。不能依赖资产层的 SPA 回退
  // （not_found_handling = none）：否则 /assets/过期hash.js 这类缺失文件会
  // 拿到被 _headers 标 immutable 的回退 HTML。纯 API 路径仍回 JSON 404。
  app.notFound(async (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'common.not_found' }, 404);
    if (!c.env.ASSETS) return c.json({ error: 'common.not_found' }, 404);
    // 未知 .well-known 子路径是客户端/工具的探测流量（ACME、应用关联等），
    // 不存在对应页面，直接 404，不进 SEO 渲染白耗查询。已知端点
    // （change-password 与 connect 的发现路由）都在这条之前被接住。
    if (c.req.path.startsWith('/.well-known/') && c.req.path !== '/.well-known/change-password') {
      return c.json({ error: 'common.not_found' }, 404);
    }
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status === 200 && !asset.headers.get('content-type')?.includes('text/html')) return asset;
    const html = asset.status === 200 ? asset : await c.env.ASSETS.fetch(new URL('/index.html', c.req.url));
    if (html.status === 200 && html.headers.get('content-type')?.includes('text/html') && ['GET', 'HEAD'].includes(c.req.method)) {
      const path = c.req.path === '/index.html' ? '/' : canonicalPagePath(c.req.path);
      if (path !== c.req.path) return c.redirect(`${path}${new URL(c.req.url).search}`, 301);
      return renderSearchPage(html, c.env, c.req.raw);
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
