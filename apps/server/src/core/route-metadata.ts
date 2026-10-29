/** Shared path knowledge for cross-cutting middleware and generated robots.txt. */

type DelegatedResource = {
  pattern: RegExp;
  module: string;
};

const delegatedResources: DelegatedResource[] = [
  { pattern: /^\/api\/v1\/(?:notifications(?:\/\d+\/read|\/read-all)?|me\/notifications)$/, module: 'Notification' },
  { pattern: /^\/api\/v1\/players(?:\/\d+(?:\/textures)?)?$/, module: 'Player' },
  { pattern: /^\/api\/v1\/closet(?:\/\d+)?$/, module: 'Closet' },
  { pattern: /^\/api\/v1\/admin\/users(?:\/\d+)?$/, module: 'UsersManagement' },
  { pattern: /^\/api\/v1\/admin\/users\/\d+\/closet(?:\/\d+)?$/, module: 'ClosetManagement' },
  { pattern: /^\/api\/v1\/admin\/players(?:\/\d+)?$/, module: 'PlayersManagement' },
  { pattern: /^\/api\/v1\/reports\/(?:admin|\d+\/resolve)$/, module: 'ReportsManagement' },
];

export function delegatedScopesForRoute(path: string, method: string): string[] | null {
  const read = method === 'GET';
  if (path === '/api/v1/me' && read) return ['User.Read'];
  if (path === '/api/v1/admin/notifications' && method === 'POST') return ['Notification.ReadWrite'];

  const resource = delegatedResources.find(({ pattern }) => pattern.test(path));
  if (!resource) return null;
  if (resource.module === 'Notification' && !read) return ['Notification.Read', 'Notification.ReadWrite'];
  return read ? [`${resource.module}.Read`, `${resource.module}.ReadWrite`] : [`${resource.module}.ReadWrite`];
}

export const CSRF_EXEMPT_PREFIXES = ['/api/v1/health', '/api/v1/settings/public'] as const;

const PROTOCOL_PREFIXES = ['/textures/', '/csl/', '/raw/', '/avatar/', '/preview/'] as const;
const OAUTH_PROTOCOL_PATH = /^\/(?:yggc|oauth)\/(?:authorize|token|device_authorization|revocation|revoke|introspection|userinfo)$/;

export function isProtocolPath(pathname: string): boolean {
  return PROTOCOL_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || pathname.endsWith('.json');
}

export function isOAuthProtocolPath(pathname: string): boolean {
  return OAUTH_PROTOCOL_PATH.test(pathname);
}

export const AUTH_RATE_LIMIT_PREFIXES = [
  '/api/v1/auth/',
  '/auth/oauth/',
  // PHP 版回调别名：与 /auth/oauth 同强度，避免同一流程按路径分流到不同桶
  '/auth/login/',
  '/oauth/',
  '/yggc/',
  '/api/v1/connect/',
  '/api/yggdrasil/authserver/',
] as const;

export function isAuthRateLimitedPath(pathname: string): boolean {
  return AUTH_RATE_LIMIT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export const ROBOTS_API_RULES = [
  'Disallow: /api/',
  'Allow: /api/v1/settings/public',
  'Allow: /api/v1/manual',
  'Allow: /api/v1/translations',
  'Allow: /api/v1/textures',
] as const;

export const ROBOTS_PROTOCOL_DISALLOW = ['Disallow: /raw/', 'Disallow: /textures/'] as const;

// ── 抓取代理拦截 ─────────────────────────────────────────────────────────────
//
// 产品决策：全站禁止 Anthropic / Claude 的抓取代理抓取本站内容。
// robots.txt 为每个 UA 单独输出独立分组（独立分组优先于下面的 `*`，
// 因此 /api/v1/textures 等 Allow 例外对这组 UA 不生效），请求层再按
// 同一清单返回 403 —— robots.txt 只是约定，不遵守的抓取方需要兜底拦截。
//
// ClaudeBot / Claude-SearchBot 是 Anthropic 官方公开的自动抓取标识
// （训练、搜索），Claude-Web 与 anthropic-ai 是更早的标识，一并保留。
// Claude-User 是用户主动让 Claude 读取某个页面的代理，不是爬虫，
// 不在此列 —— 放行它，用户点名访问的页面仍然可读。
export const BLOCKED_CRAWLER_AGENTS = [
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-Web',
  'anthropic-ai',
] as const;

/** User-Agent 子串匹配（大小写不敏感）。缺失 UA 不视为爬虫。 */
export function isBlockedCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BLOCKED_CRAWLER_AGENTS.some((agent) => ua.includes(agent.toLowerCase()));
}

// ── SEO 快照投放 ─────────────────────────────────────────────────────────────
// SPA 深链的 SEO 快照（services/seo.ts）只投放给搜索引擎与分享预览抓取方：
// 不执行 JS 的引擎只有快照能提供正文，而快照正文一旦进普通用户的响应，
// JS 加载失败时就会把爬虫文案直接暴露给用户。
// 清单只放"绝不可能是真人浏览器"的标识；bot/crawler/spider/slurp 兜底正则
// 覆盖其余已知与未知爬虫（百度/搜狗/360/字节等中文引擎的 UA 都带 spider）。
// 品牌词不能作为判定依据：搜狗、夸克等浏览器的 UA 与同名爬虫无法按品牌
// 区分（如 SogouMobileBrowser），微信/QQ/WhatsApp 的内置浏览器 UA 与其
// 链接预览抓取方相同，一律按普通浏览器对待，预览卡片回退到 index.html。
export const SEO_CRAWLER_AGENTS = [
  'Google-InspectionTool',
  'BingPreview',
  'Yandex',
  'facebookexternalhit',
  'SkypeUriPreview',
] as const;

const SEO_CRAWLER_FALLBACK = /bot|crawler|spider|slurp/i;

/** 缺失 UA 不视为爬虫：未知客户端按普通浏览器对待。 */
export function isSeoCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return SEO_CRAWLER_AGENTS.some((agent) => userAgent.toLowerCase().includes(agent.toLowerCase())) || SEO_CRAWLER_FALLBACK.test(userAgent);
}

// ── SPA 页面路径分类 ─────────────────────────────────────────────────────────
// 未命中资产层时只有这些路径回退 SPA 入口（200）；其余（协议端点、未知路径）
// 一律 404 —— 协议客户端（启动器、游戏）依赖 404 判定资源缺失，不能拿到
// HTML。快照渲染（seo.ts）与 SPA 回退（app.ts notFound）必须用同一份分类，
// 否则爬虫与用户会对同一路径给出不同的状态码。
export function isSpaPagePath(path: string): boolean {
  return path === '/'
    || path === '/skinlib' || /^\/skinlib\/[1-9]\d*$/.test(path)
    || path === '/manual' || path.startsWith('/manual/')
    || /^\/(?:admin|user|player|closet|profile|reports|votes|connect|auth)(?:\/|$)/.test(path)
    || ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/setup', '/connections', '/.well-known/change-password'].includes(path);
}

/** robots.txt 规则修订号：规则变化时递增，让 Cache API 里缓存的旧 robots.txt 立即失效。 */
export const ROBOTS_RULES_REVISION = 3;

// ── 会话中间件的路径白名单（app.ts 消费）──────────────────────────────────────
// 这些清单表达"哪些路由对受限会话可用"的产品决策，与路由定义集中放在一起，
// 避免散落在装配层成为影子副本。

/** 被封禁用户仍可访问的路径：登出与读取自身会话。 */
export const BANNED_ALLOWED_PATHS = ['/api/v1/auth/logout', '/api/v1/auth/session'] as const;

/**
 * 凭请求体或挑战 Cookie 自证的认证端点：Authorization 头在这里被忽略。
 * 否则前端带着**过期的** access token 访问它们会在中间件就被 401 挡住 ——
 * 登录、刷新、换取令牌、2FA 挑战这些流程本身就是为了获取/续期有效令牌。
 */
export const AUTH_BODY_PREFIXES = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/token',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/captcha/',
  '/api/v1/auth/2fa',
  '/api/v1/auth/passkeys',
  '/api/v1/auth/verify-email/confirm',
] as const;

export function isAuthBodyPath(pathname: string): boolean {
  return AUTH_BODY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** 账号未初始化时可访问的写路径（PATCH /me 等有独立的 method 条件，不在此列）。 */
export const INITIALIZATION_ALLOWED_PATHS = [
  '/api/v1/auth/session',
  '/api/v1/auth/initialize',
  '/api/v1/auth/logout',
  '/api/v1/auth/verify-email/request',
  '/api/v1/auth/verify-email/confirm',
  '/api/v1/me',
] as const;

/** 账号未初始化时的公开只读前缀（GET）。 */
export const INITIALIZATION_PUBLIC_READ_PREFIXES = [
  '/api/v1/manual',
  '/api/v1/settings/public',
  '/api/v1/translations',
  '/api/v1/site-script.js',
  '/api/v1/live2d',
  '/api/v1/oauth/providers',
  '/api/v1/textures',
  '/api/v1/users',
  '/api/v1/health',
] as const;
