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

/** robots.txt 规则修订号：规则变化时递增，让 Cache API 里缓存的旧 robots.txt 立即失效。 */
export const ROBOTS_RULES_REVISION = 3;

// ── 会话中间件的路径白名单（app.ts 消费）──────────────────────────────────────
// 这些清单表达"哪些路由对受限会话可用"的产品决策，与路由定义集中放在一起，
// 避免散落在装配层成为影子副本。

/** 被封禁用户仍可访问的路径：登出与读取自身会话。 */
export const BANNED_ALLOWED_PATHS = ['/api/v1/auth/logout', '/api/v1/auth/session'] as const;

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
