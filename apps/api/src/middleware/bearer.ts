// 认证中间件：把当前用户挂到 context。
//
// 两类 Bearer 令牌共用一个入口，靠 JWT payload 形状区分：
//   • Web 前端 access token —— HS256，payload 带 sid claim（本站会话 id）。
//     验签零成本；撤销/封禁等强一致语义经 isolate 缓存查 sessions 行。
//   • Connect（OAuth server）签发的 access token —— RS256，payload 带
//     scopes/grant_id。原样走 oauthAuthentication（RS256 验签 + ygg_tokens）。
//
// 认证端点（login/refresh/2fa 挑战等）凭请求体或挑战 Cookie 自证身份：
// 它们仍然尽力解析 Bearer（重授权挑战需要会话上下文做绑定校验），但解析
// 失败不拦截 —— 带着过期令牌来换新令牌的请求不能在中间件就被 401 挡死。
import type { Context, MiddlewareHandler } from 'hono';
import { decodeJwt } from 'jose';
import { verifyWebAccessToken } from '@pigeon-skin/auth';
import type { AppEnv, AuthedUser } from '../lib.ts';
import { loadAuthedUser, renewSession } from '../lib.ts';
import { fail } from '../framework.ts';
import { cacheAuthedUser, cachedAuthedUser } from '../lib/auth-cache.ts';
import { oauthAuthentication } from './oauth.ts';
import {
  BANNED_ALLOWED_PATHS,
  INITIALIZATION_ALLOWED_PATHS,
  INITIALIZATION_PUBLIC_READ_PREFIXES,
  isAuthBodyPath,
} from '../route-metadata.ts';

/** payload 带 sid claim 的才是 web access token（Connect 令牌没有） */
function isWebToken(token: string): boolean {
  try {
    const payload = decodeJwt(token);
    return typeof payload.sid === 'string' && !payload.scopes && !payload.grant_id;
  } catch {
    return false;
  }
}

/** 验签 + 缓存/查库解析 web 令牌；任何失败返回 null（不抛错） */
async function resolveWebToken(c: Context<AppEnv>, token: string): Promise<{ user: AuthedUser; sessionId: string } | null> {
  if (!c.env.SESSION_SECRET) return null;
  const claims = await verifyWebAccessToken(c.env.SESSION_SECRET, token);
  if (!claims) return null;
  let user = cachedAuthedUser(claims.sid);
  let lastSeenAt: number | null = null;
  if (!user) {
    const record = await loadAuthedUser(c.env, claims.sid);
    if (!record) return null;
    user = record.user;
    lastSeenAt = record.lastSeenAt;
  }
  // 滑动续期只在缓存未命中时检查：缓存命中说明 30 秒内刚查过
  if (lastSeenAt !== null) {
    cacheAuthedUser(claims.sid, user);
    await renewSession(c.env, claims.sid, lastSeenAt);
  }
  return { user, sessionId: claims.sid };
}

/**
 * 封禁与账号初始化门禁。语义与旧 cookie 会话中间件逐字一致：
 * 被封禁用户仅剩登出与读取自身会话；未初始化账号仅能走白名单路径。
 * 返回 null 表示放行。
 */
function enforceSessionGates(c: Context<AppEnv>, user: AuthedUser): Response | null {
  if (user.role === 'banned') {
    if (!(BANNED_ALLOWED_PATHS as readonly string[]).includes(c.req.path)) {
      return c.json({ error: 'auth.account_banned' }, 403);
    }
  }
  if (user.needsInitialization && c.req.path.startsWith('/api/v1/')) {
    const path = c.req.path;
    const allowed = (INITIALIZATION_ALLOWED_PATHS as readonly string[]).includes(path);
    const publicRead = c.req.method === 'GET' && (INITIALIZATION_PUBLIC_READ_PREFIXES as readonly string[]).some(prefix => path === prefix || path.startsWith(prefix + '/'));
    const preferences = path === '/api/v1/me/preferences' && c.req.method === 'PATCH';
    const security = path === '/api/v1/me/security' || path.startsWith('/api/v1/me/security/') || path === '/api/v1/auth/2fa' || path.startsWith('/api/v1/auth/2fa/') || (path === '/api/v1/me/oauth' && c.req.method === 'GET');
    if (!publicRead && !preferences && !security && !(allowed && (path !== '/api/v1/me' || c.req.method === 'GET'))) {
      return c.json({ error: 'auth.initialization_required' }, 403);
    }
  }
  return null;
}

export function bearerAuthentication(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    const token = authorization ? /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? '' : '';

    // 空令牌（"Bearer " 后无内容）按匿名处理：公开端点的调用方可能带上空壳头
    if (!token) {
      c.set('user', null);
      c.set('sessionId', null);
      return next();
    }

    if (!isWebToken(token)) {
      // Connect 签发的令牌只服务 /api/v1 的委托资源
      if (!c.req.path.startsWith('/api/v1/')) {
        c.set('user', null);
        c.set('sessionId', null);
        return next();
      }
      return oauthAuthentication()(c, next);
    }

    const authBody = isAuthBodyPath(c.req.path);
    const resolved = await resolveWebToken(c, token);
    if (!resolved) {
      // 认证端点允许带着无效/过期令牌进入（它们本身就是来换新身份的）；
      // 其余路由凭据失效一律 401
      if (authBody) {
        c.set('user', null);
        c.set('sessionId', null);
        return next();
      }
      throw fail.unauthorized();
    }
    c.set('user', resolved.user);
    c.set('sessionId', resolved.sessionId);
    const gate = enforceSessionGates(c, resolved.user);
    if (gate) return gate;
    return next();
  };
}
