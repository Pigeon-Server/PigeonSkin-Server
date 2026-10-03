import type { MiddlewareHandler } from 'hono';
import { createDb, users } from '@pigeon-skin/db';
import { eq } from 'drizzle-orm';
import type { AppEnv, AuthedUser } from '../lib.ts';
import { OAuthError, verifyConnectToken } from '../services/connect.ts';
import { delegatedScopesForRoute } from '../route-metadata.ts';

export function delegatedScopes(path: string, method: string): string[] | null {
  return delegatedScopesForRoute(path, method);
}

export function oauthCors(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const preflight = c.req.method === 'OPTIONS';
    const requestedMethod = preflight ? c.req.header('access-control-request-method') || 'GET' : c.req.method;
    if (delegatedScopes(c.req.path, requestedMethod) && (preflight || c.req.header('authorization'))) {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (preflight) return c.body(null, 204);
    }
    await next();
  };
}

export function oauthAuthentication(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    if (!authorization || !c.req.path.startsWith('/api/v1/')) return next();
    if (!/^Bearer [A-Za-z0-9._~-]+$/i.test(authorization)) throw new OAuthError('invalid_token', 'Bearer access token required.', 401);
    const { grant, scopes } = await verifyConnectToken(c, authorization.slice(7));
    const allowed = delegatedScopes(c.req.path, c.req.method);
    if (!allowed || !allowed.some(s => scopes.includes(s))) throw new OAuthError('insufficient_scope', 'Insufficient scope.', 403);
    const [user] = await createDb(c.env.DB).select().from(users).where(eq(users.id, grant.user_id)).limit(1);
    if (!user || user.role === 'banned') throw new OAuthError('invalid_token', 'Account unavailable.', 401);
    c.set('user', { ...user, needsInitialization: false } as AuthedUser);
    c.set('sessionId', null);
    c.header('Cache-Control', 'no-store');
    await next();
  };
}
