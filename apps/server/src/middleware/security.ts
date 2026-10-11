// 横切安全中间件：CSRF 防线与限流。
//
// CSRF 采用「校验请求来源」方案而不是双提交令牌：
//   • 本站 Cookie 是 SameSite=Lax + HttpOnly，跨站请求带不上会话，
//     Lax 本身已挡掉绝大多数 CSRF；
//   • 再加一层 Origin/Sec-Fetch-Site 校验，防御 Lax 未覆盖的残余场景
//     （旧浏览器、非常规顶级导航后的 POST）；
//   • API 是纯 JSON 消费方，没有跨站嵌入图片/表单的合法需求，
//     所以可以放心地按"来源不对就拒绝"处理。
//
// 对 Minecraft 协议路由与 /api/health 这类无凭据读端点不生效 —— 它们
// 不读 Cookie，CSRF 对它们没有意义。

import type { MiddlewareHandler } from 'hono';
import { flag } from '../env.ts';
import type { AppEnv } from '../lib.ts';
import { CSRF_EXEMPT_PREFIXES, isAuthRateLimitedPath, isBlockedCrawler, isOAuthProtocolPath, isProtocolPath } from '../route-metadata.ts';

/** 哪些请求方法会改状态、需要校验来源 */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfProtection(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { method } = c.req;
    const path = new URL(c.req.url).pathname;

    if (isOAuthProtocolPath(path)) return next();
    if (path.startsWith('/api/v1/') && /^Bearer /i.test(c.req.header('authorization') || '')) return next();

    if (!STATE_CHANGING.has(method) || isProtocolPath(path)) return next();
    if (CSRF_EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return next();

    // Sec-Fetch-Site 由现代浏览器强制设置且不可伪造（JS 无法覆盖它）。
    // 'same-origin' / 'none'（非浏览器客户端，如 curl/迁移脚本）都放行；
    // 没有 Sec-Fetch-Site 的旧浏览器回落到 Origin 比对。
    const fetchSite = c.req.header('sec-fetch-site');
    if (fetchSite === 'same-origin' || fetchSite === 'none') return next();

    const origin = c.req.header('origin');
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        // Origin 头畸形 → 来源不明，拒绝
        return c.json({ error: 'common.forbidden' }, 403);
      }
      if (originHost === new URL(c.req.url).host) return next();
      return c.json({ error: 'common.forbidden' }, 403);
    }

    // 既没有 Sec-Fetch-Site 也没有 Origin：老客户端直接发 JSON POST。
    // 放行 —— 因为凭据在 SameSite=Lax 的 HttpOnly Cookie 里，真正的
    // 浏览器攻击面已被前两层覆盖；这里第三层只处理"可识别的现代浏览器"。
    return next();
  };
}

// ── 抓取代理拦截 ─────────────────────────────────────────────────────────────
//
// robots.txt 声明了禁止范围（见 routes/sitemap.ts），但 robots 只是约定，
// 抓取方可以无视；这里按同一清单在请求层返回 403 兜底。清单与匹配规则集中在
// route-metadata.ts，保证声明与拦截不会各说各话。
//
// /robots.txt 自身放行：合规爬虫要先读到规则才知道自己被禁止；对 robots.txt
// 返回 403/404 在 RFC 9309 下等于"无限制"，反而会把禁止声明一起挡掉。

export function blockedCrawlerGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.path === '/robots.txt') return next();
    if (isBlockedCrawler(c.req.header('user-agent'))) {
      c.header('Cache-Control', 'no-store');
      // 短路 403 不经过 secureHeaders，安全头自己补齐
      c.header('X-Content-Type-Options', 'nosniff');
      return c.text('Forbidden', 403);
    }
    return next();
  };
}

// ── 限流 ─────────────────────────────────────────────────────────────────────
//
// 用 Workers 原生 Rate Limiting binding（`[[ratelimits]]`）：它跑在
// Cloudflare 边缘、无存储成本、免费层可用。不引 DO/KV 方案 ——
// 文档 34 明确反对为限流引入 Durable Objects。
//
// 两个桶：
//   • global  —— 每个 IP 对整个 API 的请求，防扫描与滥用
//   • auth    —— 认证端点（register/login/forgot），更紧
//
// binding 缺失（未部署 ratelimits 配置、或本地未启用）时 fail-open：
// 限流是纵深防御的一层，缺了不该把整站打挂。开关 RATE_LIMIT_ENABLED
// 用于显式关闭。

export function rateLimiter(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const env = c.env;
    if (!flag(env.RATE_LIMIT_ENABLED)) return next();

    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('cf-connecting-ip') || 'unknown';
    const path = new URL(c.req.url).pathname;

    // 认证端点用更紧的桶；协议路由不占 API 桶（它们有自己的边缘缓存）
    const isAuthPath = isAuthRateLimitedPath(path);
    const binding = isAuthPath ? env.RL_AUTH : env.RL_GLOBAL;
    if (binding) {
      const key = isAuthPath ? `auth:${ip}` : `api:${ip}`;
      try {
        const result = await binding.limit({ key });
        if (!result.success) {
          return c.json({ error: 'common.rate_limited' }, 429, { 'Retry-After': '60' });
        }
      } catch {
        // binding 故障 fail-open：不能因为限流器把正常用户挡在门外
      }
    }

    return next();
  };
}
