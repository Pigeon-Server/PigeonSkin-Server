import { SignJWT, importJWK, jwtVerify, base64url, type JWK } from 'jose';
import { hashToken } from '@pigeon-skin/auth';
import type { Context } from 'hono';
import { getSettingBool, getSettingInt, needsAccountInitialization, type AppEnv } from '../lib.ts';
import { gameProfiles, publicProfile, uuidForPlayer } from './ygg-profiles.ts';

export type ConnectContext = Context<AppEnv>;
export const CONNECT_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'Yggdrasil.PlayerProfiles.Read', 'Yggdrasil.PlayerProfiles.Select', 'Yggdrasil.PlayerProfiles.Upload', 'Yggdrasil.Server.Join',
  'User.Read', 'Notification.Read', 'Notification.ReadWrite', 'Player.Read', 'Player.ReadWrite', 'Closet.Read', 'Closet.ReadWrite',
  'UsersManagement.Read', 'UsersManagement.ReadWrite', 'PlayersManagement.Read', 'PlayersManagement.ReadWrite', 'ClosetManagement.Read', 'ClosetManagement.ReadWrite', 'ReportsManagement.Read', 'ReportsManagement.ReadWrite'] as const;
export class OAuthError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 403 | 503;
  constructor(code: string, message = code, status: 400 | 401 | 403 | 503 = 400) {
    super(message); this.code = code; this.status = status;
  }
}
export interface ConnectClient {
  id: string; name: string; secret_hash: string | null; redirect_uris: string;
  enabled: number; shared: number; created_at: number; user_id: number | null;
}
export interface Grant {
  id: string; user_id: number; client_id: string; player_id: number | null;
  scopes: string; created_at: number; expires_at: number; revoked_at: number | null; auth_time: number;
}
interface SigningKey { kid: string; private_jwk: string; public_jwk: string }
interface Account { id: number; role: string; email: string; nickname: string; email_verified_at: number | null; password_hash: string; needs_initialization: number }

export const issuer = (c: ConnectContext) => `${c.env.APP_URL.replace(/\/$/, '')}/yggc`;
export function randomSecret() {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}
export async function connectEnabled(c: ConnectContext) {
  if (!await getSettingBool(c.env, 'ygg_connect_enabled') && !await getSettingBool(c.env, 'oauth_enabled')) throw new OAuthError('temporarily_unavailable', 'OAuth is disabled.', 503);
  if (c.env.ENVIRONMENT !== 'development' && !issuer(c).startsWith('https://')) throw new OAuthError('temporarily_unavailable', 'HTTPS issuer required.', 503);
}
export async function clientById(c: ConnectContext, id: string) {
  const client = await c.env.DB.prepare('SELECT * FROM connect_clients WHERE id = ? AND enabled = 1').bind(id).first<ConnectClient>();
  if (!client) throw new OAuthError('invalid_client', 'Unknown or disabled client.', 401);
  return client;
}
export async function authenticateClient(c: ConnectContext, params: URLSearchParams) {
  let id = params.get('client_id') || '', secret = params.get('client_secret');
  const authorization = c.req.header('authorization');
  if (authorization) {
    if (!/^Basic [A-Za-z0-9+/]+=*$/i.test(authorization) || params.has('client_secret')) throw new OAuthError('invalid_client', 'Conflicting client authentication.', 401);
    try {
      const decoded = atob(authorization.slice(6)), colon = decoded.indexOf(':');
      if (colon < 0) throw new Error();
      id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' '));
      secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '));
    } catch { throw new OAuthError('invalid_client', 'Invalid client credentials.', 401); }
    if (params.has('client_id') && params.get('client_id') !== id) throw new OAuthError('invalid_client', 'Conflicting client identifiers.', 401);
  }
  const client = await clientById(c, id);
  if (client.secret_hash) {
    if (!secret || await hashToken(secret) !== client.secret_hash) throw new OAuthError('invalid_client', 'Invalid client credentials.', 401);
  } else if (secret !== null || authorization) throw new OAuthError('invalid_client', 'Public clients must not send a secret.', 401);
  return client;
}
export function validRedirect(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)) || (!['http:', 'javascript:', 'data:', 'file:', 'ftp:', 'blob:'].includes(u.protocol) && !['https:', 'http:'].includes(u.protocol) && u.protocol.length > 2);
  } catch { return false; }
}
export function matchRedirect(client: ConnectClient, uri: string) {
  if (!validRedirect(uri)) return false;
  return (JSON.parse(client.redirect_uris) as string[]).some(registered => {
    if (registered === uri) return true;
    const a = new URL(registered), b = new URL(uri);
    if (a.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(a.hostname)) return false;
    a.port = ''; b.port = '';
    return a.href === b.href;
  });
}
export function validateScopes(value: string) {
  const scopes = [...new Set(value.split(' ').filter(Boolean).map(s => s === 'Closet.ReadWrtie' ? 'Closet.ReadWrite' : s))];
  if (!scopes.length || scopes.some(s => !CONNECT_SCOPES.includes(s as typeof CONNECT_SCOPES[number]))) throw new OAuthError('invalid_scope');
  if (scopes.some(s => ['profile', 'email'].includes(s) || s.startsWith('Yggdrasil.')) && !scopes.includes('openid')) throw new OAuthError('invalid_scope', 'Identity scopes require openid.');
  if (scopes.includes('Yggdrasil.Server.Join') && !scopes.includes('Yggdrasil.PlayerProfiles.Select')) throw new OAuthError('invalid_scope', 'Server.Join requires PlayerProfiles.Select.');
  if (scopes.includes('Yggdrasil.PlayerProfiles.Upload') && !scopes.includes('Yggdrasil.PlayerProfiles.Select')) throw new OAuthError('invalid_scope', 'PlayerProfiles.Upload requires PlayerProfiles.Select.');
  if (scopes.includes('Yggdrasil.PlayerProfiles.Select') && scopes.includes('Yggdrasil.PlayerProfiles.Read')) throw new OAuthError('invalid_scope', 'Select and Read are mutually exclusive.');
  return scopes;
}
export async function scopesEnabled(c: ConnectContext, scopes: string[]) {
  if (scopes.some(s => s.startsWith('Yggdrasil.')) && !await getSettingBool(c.env, 'ygg_connect_enabled')) throw new OAuthError('temporarily_unavailable', 'Yggdrasil Connect is disabled.', 503);
  if (scopes.some(s => /^[A-Z]/.test(s) && !s.startsWith('Yggdrasil.')) && !await getSettingBool(c.env, 'oauth_enabled')) throw new OAuthError('temporarily_unavailable', 'API authorization is disabled.', 503);
}
export async function account(c: ConnectContext, userId: number) {
  const user = await c.env.DB.prepare('SELECT id, role, email, nickname, email_verified_at, password_hash, needs_initialization FROM users WHERE id = ?').bind(userId).first<Account>();
  if (!user || user.role === 'banned' || (await getSettingBool(c.env, 'require_email_verification') && !user.email_verified_at)) throw new OAuthError('access_denied', 'Account is unavailable.', 403);
  if (needsAccountInitialization(user.email, user.password_hash, user.needs_initialization)) throw new OAuthError('interaction_required', 'Account initialization required.', 403);
  return user;
}
export async function activeGrant(c: ConnectContext, grantId: string, clientId?: string) {
  const grant = await c.env.DB.prepare('SELECT g.* FROM connect_grants g JOIN connect_clients c ON c.id = g.client_id WHERE g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND c.enabled = 1').bind(grantId, Date.now()).first<Grant>();
  if (!grant || (clientId && grant.client_id !== clientId)) throw new OAuthError('invalid_grant');
  try { await account(c, grant.user_id); } catch { throw new OAuthError('invalid_grant'); }
  if (grant.player_id !== null) {
    const player = await c.env.DB.prepare('SELECT user_id FROM players WHERE id = ?').bind(grant.player_id).first<{ user_id: number }>();
    if (!player || player.user_id !== grant.user_id) throw new OAuthError('invalid_grant');
  }
  return grant;
}
export async function claimsFor(c: ConnectContext, grant: Grant, scopes: string[]) {
  const user = await account(c, grant.user_id);
  const claims: Record<string, unknown> = { sub: String(user.id), aud: grant.client_id };
  if (scopes.includes('profile')) {
    claims.nickname = user.nickname;
    const avatar = await c.env.DB.prepare("SELECT t.hash FROM textures t JOIN users u ON u.avatar_texture_id = t.id WHERE u.id = ? AND t.visibility = 'public'").bind(user.id).first<{ hash: string }>();
    if (avatar) claims.picture = `${c.env.APP_URL.replace(/\/$/, '')}/avatar/${avatar.hash}?mode=2d&size=100`;
  }
  if (scopes.includes('email')) { claims.email = user.email; claims.email_verified = user.email_verified_at !== null; }
  if (scopes.includes('Yggdrasil.PlayerProfiles.Read')) claims.availableProfiles = (await gameProfiles(c, user.id)).map(publicProfile);
  if (scopes.includes('Yggdrasil.PlayerProfiles.Select')) {
    if (grant.player_id === null) throw new OAuthError('invalid_grant');
    claims.selectedProfile = publicProfile(await uuidForPlayer(c, grant.player_id));
  }
  return claims;
}
export async function rotateConnectKey(c: ConnectContext, initial = false) {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const kid = crypto.randomUUID();
  const privateJwk = { ...await crypto.subtle.exportKey('jwk', pair.privateKey), kid, alg: 'RS256', use: 'sig' };
  const publicJwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg: 'RS256', use: 'sig' };
  await c.env.DB.batch([
    ...(!initial ? [c.env.DB.prepare("UPDATE connect_keys SET retired_at = ?, private_jwk = '' WHERE retired_at IS NULL").bind(Date.now())] : []),
    c.env.DB.prepare('INSERT INTO connect_keys (kid, private_jwk, public_jwk, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM connect_keys WHERE retired_at IS NULL)').bind(kid, JSON.stringify(privateJwk), JSON.stringify(publicJwk), Date.now()),
  ]);
  return { kid, publicKey: publicJwk };
}
async function signingKey(c: ConnectContext) {
  let row = await c.env.DB.prepare('SELECT kid, private_jwk, public_jwk FROM connect_keys WHERE retired_at IS NULL').first<SigningKey>();
  if (!row) {
    await rotateConnectKey(c, true);
    row = await c.env.DB.prepare('SELECT kid, private_jwk, public_jwk FROM connect_keys WHERE retired_at IS NULL').first<SigningKey>();
  }
  if (!row) throw new OAuthError('temporarily_unavailable', 'Connect signing key is not configured.', 503);
  return { kid: row.kid, key: await importJWK(JSON.parse(row.private_jwk) as JWK, 'RS256') };
}
export async function idToken(c: ConnectContext, grant: Grant, scopes: string[], nonce: string | null, code?: string, accessToken?: string) {
  const claims = await claimsFor(c, grant, scopes);
  if (grant.auth_time > 0) claims.auth_time = Math.floor(grant.auth_time / 1000);
  if (nonce) claims.nonce = nonce;
  for (const [name, value] of [['c_hash', code], ['at_hash', accessToken]]) {
    if (value) claims[name!] = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).slice(0, 16));
  }
  const key = await signingKey(c);
  const ttl = Math.min(await getSettingInt(c.env, 'ygg_token_expire_1'), Math.floor((grant.expires_at - Date.now()) / 1000));
  if (ttl < 1) throw new OAuthError('invalid_grant');
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: key.kid }).setIssuer(issuer(c)).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + ttl).sign(key.key);
}
export async function tokenBundle(c: ConnectContext, grant: Grant, scopes: string[], nonce: string | null) {
  const key = await signingKey(c);
  const now = Date.now();
  const ttl = Math.min(await getSettingInt(c.env, 'ygg_token_expire_1'), Math.floor((grant.expires_at - now) / 1000));
  if (ttl < 1) throw new OAuthError('invalid_grant');
  const profile = grant.player_id === null ? null : await uuidForPlayer(c, grant.player_id);
  const token = await new SignJWT({ selectedProfile: profile?.id, scopes, grant_id: grant.id })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'at+jwt' }).setIssuer(issuer(c)).setSubject(String(grant.user_id)).setAudience(grant.client_id)
    .setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime(Math.floor(now / 1000) + ttl).sign(key.key);
  const refresh = scopes.includes('offline_access') ? randomSecret() : null;
  const response = { access_token: token, token_type: 'Bearer', expires_in: ttl, scope: scopes.join(' '), ...(scopes.includes('openid') ? { id_token: await idToken(c, grant, scopes, nonce, undefined, token) } : {}), ...(refresh ? { refresh_token: refresh } : {}) };
  const statements = (table: 'connect_codes' | 'connect_refresh' | 'connect_devices', consumedId: string, consumeKey: string) => {
    const guard = `EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND consume_key = ?) AND EXISTS (SELECT 1 FROM connect_grants g JOIN connect_clients c ON c.id = g.client_id JOIN users u ON u.id = g.user_id WHERE g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND c.enabled = 1 AND u.role != 'banned')`;
    const result = [c.env.DB.prepare(`INSERT INTO ygg_tokens (id, user_id, client_token, created_at, expires_at, refresh_deadline, player_id, profile_uuid, profile_version, source, grant_id, scopes) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connect', ?, ? WHERE ${guard}`)
      .bind(hashTokenValue, grant.user_id, grant.client_id, now, now + ttl * 1000, grant.expires_at, profile?.playerId ?? null, profile?.id ?? null, profile?.version ?? null, grant.id, JSON.stringify(scopes), consumedId, consumeKey, grant.id, now)];
    if (refreshHash) result.push(c.env.DB.prepare(`INSERT INTO connect_refresh (id, grant_id, scopes, expires_at) SELECT ?, ?, ?, ? WHERE ${guard}`).bind(refreshHash, grant.id, JSON.stringify(scopes), grant.expires_at, consumedId, consumeKey, grant.id, now));
    return result;
  };
  const hashTokenValue = await hashToken(token), refreshHash = refresh ? await hashToken(refresh) : null;
  return { response, statements };
}
export async function revokeGrant(c: ConnectContext, grantId: string) {
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE connect_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(Date.now(), grantId),
    c.env.DB.prepare('DELETE FROM ygg_tokens WHERE grant_id = ?').bind(grantId),
    c.env.DB.prepare('DELETE FROM ygg_sessions WHERE player_id = (SELECT player_id FROM connect_grants WHERE id = ?)').bind(grantId),
  ]);
}
export async function verifyConnectToken(c: ConnectContext, raw: string, scope?: string) {
  await connectEnabled(c);
  try {
    const { payload } = await jwtVerify(raw, async header => {
      if (header.alg !== 'RS256' || header.typ !== 'at+jwt' || !header.kid) throw new Error('Invalid token header');
      const row = await c.env.DB.prepare('SELECT public_jwk FROM connect_keys WHERE kid = ?').bind(header.kid).first<{ public_jwk: string }>();
      if (!row) throw new Error('Unknown signing key');
      return importJWK(JSON.parse(row.public_jwk) as JWK, 'RS256');
    }, { issuer: issuer(c), algorithms: ['RS256'], requiredClaims: ['sub', 'aud', 'exp', 'iat', 'jti', 'grant_id'] });
    const row = await c.env.DB.prepare('SELECT * FROM ygg_tokens WHERE id = ? AND source = ? AND expires_at > ?').bind(await hashToken(raw), 'connect', Date.now()).first<{ user_id: number; profile_uuid: string | null; profile_version: number | null; grant_id: string; scopes: string }>();
    if (!row || payload.sub !== String(row.user_id) || payload.grant_id !== row.grant_id) throw new Error('Unknown token');
    const grant = await activeGrant(c, row.grant_id);
    if (payload.aud !== grant.client_id) throw new Error('Invalid audience');
    const scopes = JSON.parse(row.scopes) as string[];
    await scopesEnabled(c, scopes);
    if (scope && !scopes.includes(scope)) throw new OAuthError('insufficient_scope', 'Insufficient scope.', 403);
    if (grant.player_id !== null) {
      const p = await uuidForPlayer(c, grant.player_id);
      if (p.id !== row.profile_uuid || p.version !== row.profile_version) throw new Error('Profile changed');
    }
    return { grant, scopes };
  } catch (error) {
    if (error instanceof OAuthError && error.code === 'insufficient_scope') throw error;
    throw new OAuthError('invalid_token', 'Invalid or expired access token.', 401);
  }
}
