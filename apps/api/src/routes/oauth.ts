import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { createDb, userIdentities } from '@pigeon-skin/db';
import { and, eq, ne } from 'drizzle-orm';
import { hashToken } from '@pigeon-skin/auth';
import { base64url, createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { createSession, getSettingInt, getSettingBool, setSessionCookie, clientIp, needsAccountInitialization, revokeAllSessions, type AppEnv } from '../lib.ts';
import * as security from '../services/security.ts';
import * as securityRepo from '../repositories/security.ts';
import * as authRepo from '../repositories/auth.ts';
import { checkEmailDomain } from '../services/email-policy.ts';
import { AppError } from '../framework.ts';

type Ctx = Context<AppEnv>;
export interface ProviderConfig {
  readonly id: 'github' | 'littleskin' | 'microsoft';
  readonly displayName: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly userUrl: string;
  readonly scope: string;
  readonly secrets: { clientId: string; clientSecret: string };
}
function providers(c: Ctx): ProviderConfig[] {
  // 空字符串与未配置同义（.dev.vars 常见空值），必须回落官方 API 根
  const littleRoot = (c.env.LITTLESKIN_API_ROOT || 'https://littleskin.cn/api').replace(/\/$/, '');
  const littleSite = littleRoot.replace(/\/api$/, '');
  return [
    { id: 'github', displayName: 'GitHub', authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', userUrl: 'https://api.github.com/user', scope: 'read:user user:email',
      secrets: { clientId: c.env.GITHUB_CLIENT_ID ?? '', clientSecret: c.env.GITHUB_CLIENT_SECRET ?? '' } },
    { id: 'littleskin', displayName: 'LittleSkin', authorizeUrl: `${littleSite}/oauth/authorize`, tokenUrl: `${littleSite}/oauth/token`, userUrl: `${littleRoot}/user`, scope: 'User.Read',
      secrets: { clientId: c.env.LITTLESKIN_CLIENT_ID ?? '', clientSecret: c.env.LITTLESKIN_CLIENT_SECRET ?? '' } },
    { id: 'microsoft', displayName: 'Microsoft', authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', userUrl: 'https://graph.microsoft.com/v1.0/me', scope: 'openid profile email https://graph.microsoft.com/User.Read',
      secrets: { clientId: c.env.MICROSOFT_CLIENT_ID ?? '', clientSecret: c.env.MICROSOFT_CLIENT_SECRET ?? '' } },
  ];
}
export function enabledProviders(c: Ctx) {
  return providers(c).filter(p => p.secrets.clientId && p.secrets.clientSecret).map(({ id, displayName }) => ({ id, displayName }));
}
const randomSecret = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
const microsoftJwks = createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'));
const callbackUri = (c: Ctx, p: ProviderConfig) => `${c.env.APP_URL.replace(/\/$/, '')}/auth/oauth/${p.id}/callback`;
function destination(value: string) {
  return /^\/(?!\/)[A-Za-z0-9/_?=&%+.,~-]*$/.test(value) && !value.startsWith('/auth/') ? value : '/user';
}
interface LoginState { provider: string; user_id: number | null; session_id: string | null; verifier: string; destination: string }
interface RemoteUser { id: string; email: string | null; verified: boolean; name: string | null }
const securityReauthDestination = (value: string) => value === '/profile?security_reauth=1' || value === '/account/security?security_reauth=1';
async function remoteJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new AppError('auth.oauth_failed', 502);
  return response.json<unknown>();
}
async function fetchRemoteUser(c: Ctx, p: ProviderConfig, code: string, verifier: string): Promise<RemoteUser> {
  const token = await remoteJson(p.tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'PigeonSkinServer' },
    body: new URLSearchParams({ client_id: p.secrets.clientId, client_secret: p.secrets.clientSecret, code, redirect_uri: callbackUri(c, p), grant_type: 'authorization_code', ...(p.id !== 'littleskin' ? { code_verifier: verifier } : {}) }),
  }) as { access_token?: unknown; id_token?: unknown };
  if (typeof token.access_token !== 'string' || !token.access_token) throw new AppError('auth.oauth_failed', 502);
  const headers = { authorization: `Bearer ${token.access_token}`, accept: 'application/json', 'user-agent': 'PigeonSkinServer' };
  const body = await remoteJson(p.userUrl, { headers }) as Record<string, unknown>;
  const rawId = body.id ?? (p.id === 'littleskin' ? body.uid : undefined);
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '';
  if (!id) throw new AppError('auth.oauth_failed', 502);
  let email = typeof body.email === 'string' ? body.email : typeof body.mail === 'string' ? body.mail : null;
  let verified = p.id === 'littleskin' && (body.verified === true || body.verified === 1 || body.email_verified === true || typeof body.email_verified_at === 'string');
  if (p.id === 'github') {
    const emails = await remoteJson('https://api.github.com/user/emails', { headers }) as Array<{ email: string; verified: boolean; primary: boolean }>;
    if (!Array.isArray(emails)) throw new AppError('auth.oauth_failed', 502);
    const primary = emails.find(e => e.verified && e.primary) ?? emails.find(e => e.verified);
    email = primary?.email ?? null; verified = !!primary;
  }
  if (p.id === 'microsoft' && typeof token.id_token === 'string') {
    try {
      const unverified = decodeJwt(token.id_token);
      const tenant = typeof unverified.tid === 'string' ? unverified.tid : '';
      if (!/^[0-9a-f-]{36}$/i.test(tenant)) throw new Error('Invalid tenant');
      const { payload } = await jwtVerify(token.id_token, microsoftJwks, {
        issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
        audience: p.secrets.clientId,
        algorithms: ['RS256'],
      });
      if (payload.nonce !== verifier) throw new Error('Invalid nonce');
      if (typeof payload.email === 'string') email = payload.email;
      verified = typeof payload.email === 'string' && payload.email_verified === true;
    } catch {
      throw new AppError('auth.oauth_failed', 502);
    }
  }
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) email = null;
  const name = typeof body.name === 'string' ? body.name : typeof body.nickname === 'string' ? body.nickname : typeof body.displayName === 'string' ? body.displayName : typeof body.login === 'string' ? body.login : null;
  return { id, email, verified: !!email && verified, name };
}
async function issueSession(c: Ctx, userId: number, target: string) {
  if (await security.beginLogin(c, userId, { destination: target, loginSource: 'oauth' })) return c.redirect('/auth/two-factor');
  await revokeAllSessions(c.env, userId);
  const { token, maxAgeSeconds } = await createSession(c.env, userId, { ip: clientIp(c), userAgent: c.req.header('user-agent') ?? null });
  setSessionCookie(c, token, maxAgeSeconds);
  const credentials = await c.env.DB.prepare('SELECT email, password_hash, needs_initialization FROM users WHERE id = ?').bind(userId).first<{ email: string; password_hash: string; needs_initialization: number }>();
  if (credentials && needsAccountInitialization(credentials.email, credentials.password_hash, credentials.needs_initialization)) return c.redirect(`/auth/initialize?redirect=${encodeURIComponent(target)}`);
  return c.redirect(target);
}
export function registerOAuthRoutes(app: Hono<AppEnv>): void {
  const oauth = new Hono<AppEnv>();
  oauth.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  oauth.onError((error, c) => c.redirect(`${c.get('user') ? '/profile' : '/login'}?oauth_error=${encodeURIComponent(error instanceof AppError ? error.code : 'auth.oauth_failed')}`));
  app.get('/api/v1/oauth/providers', c => c.json({ providers: enabledProviders(c) }));
  oauth.get('/:provider', async c => {
    const p = providers(c).find(p => p.id === c.req.param('provider') && p.secrets.clientId && p.secrets.clientSecret);
    if (!p) throw new AppError('auth.oauth_unavailable', 404);
    const state = randomSecret(), browser = randomSecret(), verifier = randomSecret();
    const cookieName = `oauth_${state}`;
    setCookie(c, cookieName, browser, { path: '/auth/oauth', maxAge: 600, httpOnly: true, sameSite: 'Lax', secure: c.env.ENVIRONMENT !== 'development' });
    await c.env.DB.prepare('INSERT INTO oauth_login_states (id, provider, browser_hash, user_id, session_id, verifier, destination, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(await hashToken(state), p.id, await hashToken(browser), c.get('user')?.id ?? null, c.get('sessionId'), verifier, destination(c.req.query('redirect') || '/user'), Date.now() + 600000).run();
    const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    return c.redirect(`${p.authorizeUrl}?${new URLSearchParams({ client_id: p.secrets.clientId, redirect_uri: callbackUri(c, p), response_type: 'code', scope: p.scope, state, ...(p.id !== 'littleskin' ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}), ...(p.id === 'microsoft' ? { nonce: verifier } : {}) })}`);
  });
  oauth.get('/:provider/callback', async c => {
    const p = providers(c).find(p => p.id === c.req.param('provider') && p.secrets.clientId && p.secrets.clientSecret);
    if (!p) throw new AppError('auth.oauth_unavailable', 404);
    const query = new URL(c.req.url).searchParams;
    for (const name of ['state', 'code', 'error']) if (query.getAll(name).length > 1) throw new AppError('auth.oauth_failed', 400);
    const state = query.get('state') || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new AppError('auth.oauth_failed', 400);
    const cookieName = `oauth_${state}`, browser = getCookie(c, cookieName);
    if (!browser) throw new AppError('auth.oauth_failed', 400);
    const actor = c.get('user');
    const login = await c.env.DB.prepare('DELETE FROM oauth_login_states WHERE id = ? AND provider = ? AND browser_hash = ? AND user_id IS ? AND session_id IS ? AND expires_at > ? RETURNING provider, user_id, session_id, verifier, destination')
      .bind(await hashToken(state), p.id, await hashToken(browser), actor?.id ?? null, c.get('sessionId'), Date.now()).first<LoginState>();
    deleteCookie(c, cookieName, { path: '/auth/oauth' });
    if (!login) throw new AppError('auth.oauth_failed', 400);
    if (query.has('error')) throw new AppError('auth.oauth_denied', 400);
    const code = query.get('code');
    if (!code) throw new AppError('auth.oauth_failed', 400);
    const remote = await fetchRemoteUser(c, p, code, login.verifier);
    const db = createDb(c.env.DB);
    const identity = await c.env.DB.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND provider_user_id = ?').bind(p.id, remote.id).first<{ user_id: number }>();
    if (identity) {
      if (actor && identity.user_id !== actor.id) throw new AppError('auth.oauth_identity_taken', 409);
      const user = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(identity.user_id).first<{ role: string }>();
      if (!user || user.role === 'banned') throw new AppError('auth.account_banned', 403);
      if (actor && securityReauthDestination(login.destination)) {
        const config = await securityRepo.state(c.env, actor.id);
        const credentials = (await securityRepo.user(c.env, actor.id))!;
        if (credentials.password_hash || (await securityRepo.methods(c.env, actor.id)).length) throw new AppError('security.reauth_required', 403);
        await security.grantReauth(c, actor.id, { version: config.version, credentialsHash: await hashToken(`${credentials.password_hash}\n${credentials.email}\n${credentials.role}`) });
        return c.redirect(login.destination);
      }
      return actor && !login.destination.startsWith('/connect/') ? c.redirect('/profile?oauth_success=1') : issueSession(c, identity.user_id, login.destination);
    }
    if (actor) {
      if (securityReauthDestination(login.destination)) throw new AppError('security.reauth_required', 403);
      const bound = await c.env.DB.prepare('SELECT provider_user_id FROM user_identities WHERE user_id = ? AND provider = ?').bind(actor.id, p.id).first();
      if (bound) throw new AppError('auth.oauth_identity_taken', 409);
      try {
        const linked = await c.env.DB.prepare('INSERT INTO user_identities (provider, provider_user_id, user_id, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM user_identities WHERE provider = ? AND user_id = ?) RETURNING user_id').bind(p.id, remote.id, actor.id, Date.now(), p.id, actor.id).first();
        if (!linked) throw new AppError('auth.oauth_identity_taken', 409);
      }
      catch { throw new AppError('auth.oauth_identity_taken', 409); }
      return c.redirect('/profile?oauth_success=1');
    }
    let userId: number;
    const existing = remote.email ? await authRepo.findUserByEmail(db, remote.email) : null;
    if (existing) {
      if (existing.role === 'banned') throw new AppError('auth.account_banned', 403);
      if (!remote.verified || !existing.emailVerifiedAt) throw new AppError('auth.oauth_link_required', 409);
      userId = existing.id;
      try {
        const linked = await c.env.DB.prepare('INSERT INTO user_identities (provider, provider_user_id, user_id, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM user_identities WHERE provider = ? AND user_id = ?) RETURNING user_id').bind(p.id, remote.id, userId, Date.now(), p.id, userId).first();
        if (!linked) throw new AppError('auth.oauth_identity_taken', 409);
      }
      catch { throw new AppError('auth.oauth_identity_taken', 409); }
    } else {
      if (!await getSettingBool(c.env, 'registration_enabled')) throw new AppError('auth.registration_disabled', 403);
      const limit = await getSettingInt(c.env, 'regs_per_ip');
      if (remote.email) {
        const verdict = await checkEmailDomain(c.env, remote.email);
        if (verdict) throw new AppError(verdict, 403);
      }
      const email = remote.email ?? `${p.id}_${await hashToken(remote.id)}@oauth.invalid`;
      const now = Date.now(), score = await getSettingInt(c.env, 'initial_score');
      const nickname = (remote.name || remote.email?.split('@')[0] || '').slice(0, 50);
      let result;
      try {
        result = await c.env.DB.batch([
          c.env.DB.prepare("INSERT INTO users (email,nickname,password_hash,needs_initialization,role,score,registration_ip,email_verified_at,created_at,updated_at) SELECT ?,?,'',1,'normal',?,?,?,?,? WHERE ?<0 OR (SELECT COUNT(*) FROM users WHERE registration_ip=?)<? RETURNING id").bind(email, nickname, score, clientIp(c), remote.verified ? now : null, now, now, limit, clientIp(c), limit),
          c.env.DB.prepare('INSERT INTO user_identities (provider,provider_user_id,user_id,created_at) SELECT ?,?,last_insert_rowid(),? WHERE changes()>0').bind(p.id, remote.id, now),
        ]);
      } catch { throw new AppError('auth.oauth_identity_taken', 409); }
      const created = (result[0]!.results[0] as { id: number } | undefined);
      if (!created) throw new AppError('auth.too_many_registrations', 403);
      userId = created.id;
    }
    return issueSession(c, userId, login.destination);
  });
  app.post('/api/v1/me/oauth/:provider/unbind', async c => {
    const user = c.get('user');
    if (!user) throw new AppError('common.unauthorized', 401);
    const provider = c.req.param('provider');
    if (!providers(c).some(p => p.id === provider)) throw new AppError('common.not_found', 404);
    const deleted = await c.env.DB.prepare("DELETE FROM user_identities WHERE user_id = ? AND provider = ? AND (EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash != '') OR EXISTS (SELECT 1 FROM (SELECT user_id, provider FROM user_identities) AS ui WHERE ui.user_id = ? AND ui.provider IN ('github', 'littleskin', 'microsoft') AND ui.provider != ?)) RETURNING provider")
      .bind(user.id, provider, user.id, user.id, provider).first();
    if (!deleted && await c.env.DB.prepare('SELECT 1 FROM user_identities WHERE user_id = ? AND provider = ?').bind(user.id, provider).first()) throw new AppError('auth.cannot_unbind_last', 409);
    return c.json({ ok: true });
  });
  app.get('/api/v1/me/oauth', async c => {
    const user = c.get('user');
    if (!user) throw new AppError('common.unauthorized', 401);
    const rows = await createDb(c.env.DB).select({ provider: userIdentities.provider, createdAt: userIdentities.createdAt }).from(userIdentities).where(and(eq(userIdentities.userId, user.id), ne(userIdentities.provider, 'mojang')));
    const credentials = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();
    return c.json({ bindings: rows, available: enabledProviders(c), hasPassword: !!credentials?.password_hash });
  });
  app.route('/auth/oauth', oauth);
}
