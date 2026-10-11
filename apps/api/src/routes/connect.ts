import { Hono } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import { hashToken } from '@pigeon-skin/auth';
import { z } from 'zod';
import { base64url } from 'jose';
import { normalizeLocale } from '@pigeon-skin/shared/locales';
import { serviceTranslator } from '../services/translations.ts';
import { currentAdmin, currentUser, readJson } from '../framework.ts';
import { getSettingInt, type AppEnv } from '../lib.ts';
import { gameProfiles, publicProfile } from '../services/ygg-profiles.ts';
import {
  CONNECT_SCOPES, OAuthError, issuer, randomSecret, connectEnabled, clientById, authenticateClient,
  matchRedirect, validRedirect, validateScopes, scopesEnabled, account, activeGrant, claimsFor, rotateConnectKey,
  idToken, tokenBundle, revokeGrant, verifyConnectToken, type ConnectContext, type Grant,
} from '../services/connect.ts';

interface Interaction {
  id: string; client_id: string; user_id: number | null; params: string;
  expires_at: number; consumed_at: number | null;
}
interface Device {
  id: string; client_id: string; scopes: string; grant_id: string | null;
  expires_at: number; next_poll_at: number; interval_seconds: number; denied: number; consumed_at: number | null;
}
interface Code {
  id: string; grant_id: string; redirect_uri: string; challenge: string | null;
  nonce: string | null; expires_at: number; consumed_at: number | null;
}
interface Refresh { id: string; grant_id: string; scopes: string; expires_at: number; consumed_at: number | null }

async function form(c: ConnectContext) {
  if (!c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'Form encoding required.');
  const params = new URLSearchParams(await c.req.text());
  for (const key of new Set(params.keys())) if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request', 'Duplicate parameter.');
  return params;
}
function replyUri(params: Record<string, string>, values: Record<string, string>) {
  const url = new URL(params.redirect_uri!);
  const output = new URLSearchParams(values);
  if (params.state !== undefined) output.set('state', params.state);
  if (params.response_mode === 'query' || (!params.response_mode && params.response_type === 'code')) output.forEach((v, k) => url.searchParams.set(k, v));
  else url.hash = output.toString();
  return url.href;
}
async function reply(c: ConnectContext, params: Record<string, string>, values: Record<string, string>) {
  const output = { ...values, iss: issuer(c), ...(params.state !== undefined ? { state: params.state } : {}) };
  if (params.response_mode !== 'form_post') return replyUri(params, output);
  const id = randomSecret();
  await c.env.DB.prepare('INSERT INTO connect_responses (id, user_id, body, expires_at) VALUES (?, ?, ?, ?)').bind(await hashToken(id), c.get('user')?.id ?? null, JSON.stringify({ uri: params.redirect_uri, values: output }), Date.now() + 90000).run();
  return `/yggc/response/${id}`;
}
async function interaction(c: ConnectContext, raw: string) {
  const row = await c.env.DB.prepare('SELECT * FROM connect_interactions WHERE id = ? AND consumed_at IS NULL AND expires_at > ?').bind(await hashToken(raw), Date.now()).first<Interaction>();
  if (!row) throw new OAuthError('invalid_request', 'Authorization expired.');
  const user = currentUser(c);
  await account(c, user.id);
  const params = JSON.parse(row.params) as Record<string, string>;
  const session = await c.env.DB.prepare('SELECT created_at FROM sessions WHERE id = ?').bind(c.get('sessionId')).first<{ created_at: number }>();
  if (((params.prompt === 'login' || params.max_age === '0') && (!session || session.created_at < Number(params._requested_at))) || (params.max_age && Number(params.max_age) > 0 && (!session || Date.now() - session.created_at > Number(params.max_age) * 1000))) throw new OAuthError('login_required', 'Fresh authentication required.');
  if (row.user_id !== null && row.user_id !== user.id) throw new OAuthError('access_denied', 'Account changed.', 403);
  if (row.user_id === null) {
    await c.env.DB.prepare('UPDATE connect_interactions SET user_id = ? WHERE id = ? AND user_id IS NULL').bind(user.id, row.id).run();
    const bound = await c.env.DB.prepare('SELECT user_id FROM connect_interactions WHERE id = ?').bind(row.id).first<{ user_id: number }>();
    if (bound?.user_id !== user.id) throw new OAuthError('access_denied', 'Account changed.', 403);
  }
  await clientById(c, row.client_id);
  return row;
}
async function deviceByCode(c: ConnectContext, code: string) {
  const normalized = code.replace(/[-\s]/g, '').toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(normalized)) throw new OAuthError('invalid_request', 'Invalid device code.');
  const row = await c.env.DB.prepare('SELECT * FROM connect_devices WHERE user_code_hash = ? AND consumed_at IS NULL AND expires_at > ? AND grant_id IS NULL AND denied = 0').bind(await hashToken(normalized), Date.now()).first<Device>();
  if (!row) throw new OAuthError('invalid_request', 'Invalid or expired device code.');
  await clientById(c, row.client_id);
  return row;
}
async function makeGrant(c: ConnectContext, clientId: string, scopes: string[], playerId: number | null): Promise<Grant> {
  const user = currentUser(c);
  const owner = await account(c, user.id);
  if (scopes.some(s => s.includes('Management.') || s === 'Notification.ReadWrite') && !['admin', 'super_admin'].includes(owner.role)) throw new OAuthError('access_denied', 'Administrator permissions required.', 403);
  if (scopes.includes('Yggdrasil.PlayerProfiles.Select')) {
    const profiles = await gameProfiles(c, user.id);
    if (!profiles.some(p => p.playerId === playerId)) throw new OAuthError('invalid_request', 'Select an owned profile.');
  } else if (playerId !== null) throw new OAuthError('invalid_request', 'Profile selection is not authorized.');
  const now = Date.now();
  const session = await c.env.DB.prepare('SELECT created_at FROM sessions WHERE id = ?').bind(c.get('sessionId')).first<{ created_at: number }>();
  return { id: crypto.randomUUID(), user_id: user.id, client_id: clientId, player_id: playerId, scopes: JSON.stringify(scopes), created_at: now, auth_time: session?.created_at ?? now, expires_at: now + await getSettingInt(c.env, 'ygg_token_expire_2') * 1000, revoked_at: null };
}
function insertGrant(c: ConnectContext, grant: Grant, table: 'connect_devices' | 'connect_interactions', id: string, consumeKey: string) {
  return c.env.DB.prepare(`INSERT INTO connect_grants (id, user_id, client_id, player_id, scopes, created_at, expires_at, auth_time) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND consume_key = ?)`)
    .bind(grant.id, grant.user_id, grant.client_id, grant.player_id, grant.scopes, grant.created_at, grant.expires_at, grant.auth_time, id, consumeKey);
}

async function completeAuthorization(c: ConnectContext, row: Interaction, params: Record<string, string>, playerId: number | null) {
    const consumeKey = randomSecret(), now = Date.now();
    const scopes = validateScopes(params.scope!), grant = await makeGrant(c, row.client_id, scopes, playerId);
    const code = params.response_type!.includes('code') ? randomSecret() : null;
    const values: Record<string, string> = {};
    if (code) values.code = code;
    if (params.response_type!.includes('id_token')) values.id_token = await idToken(c, grant, scopes, params.nonce || null, code || undefined);
    const statements = [
      c.env.DB.prepare('UPDATE connect_interactions SET consumed_at = ?, consume_key = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?').bind(now, consumeKey, row.id, now),
      insertGrant(c, grant, 'connect_interactions', row.id, consumeKey),
    ];
    if (code) statements.push(c.env.DB.prepare('INSERT INTO connect_codes (id, grant_id, redirect_uri, challenge, nonce, expires_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connect_interactions WHERE id = ? AND consume_key = ?)').bind(await hashToken(code), grant.id, params.redirect_uri!, params.code_challenge || null, params.nonce || null, now + 600000, row.id, consumeKey));
    const result = await c.env.DB.batch(statements);
    if (!result[0]?.meta.changes) throw new OAuthError('invalid_request');
    return reply(c, params, values);
}

export function registerConnectRoutes(app: Hono<AppEnv>) {
  const r = new Hono<AppEnv>();
  r.onError((error, c) => {
    if (error instanceof OAuthError) {
      if (error.status === 401 || error.code === 'insufficient_scope') c.header('WWW-Authenticate', error.code === 'invalid_client' ? 'Basic realm="OAuth"' : `Bearer error="${error.code}"`);
      return c.json({ error: error.code, error_description: error.message }, error.status);
    }
    throw error;
  });
  r.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    await connectEnabled(c);
    if (['token', 'userinfo', 'jwks', 'device_authorization', 'revocation', 'revoke', 'introspection', 'openid-configuration', 'oauth-authorization-server'].includes(c.req.path.split('/').at(-1) || '')) {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (c.req.method === 'OPTIONS') return c.body(null, 204);
    }
    await next();
  });
  const discovery = async (c: ConnectContext) => {
    const root = issuer(c);
    const shared = await c.env.DB.prepare('SELECT id FROM connect_clients WHERE shared = 1 AND enabled = 1').first<{ id: string }>();
    return c.json({ issuer: root, authorization_endpoint: `${root}/authorize`, token_endpoint: `${root}/token`, userinfo_endpoint: `${root}/userinfo`, jwks_uri: `${root}/jwks`, device_authorization_endpoint: `${root}/device_authorization`, revocation_endpoint: `${root}/revocation`, introspection_endpoint: `${root}/introspection`,
      scopes_supported: CONNECT_SCOPES, response_types_supported: ['code', 'id_token', 'code id_token'], response_modes_supported: ['query', 'fragment', 'form_post'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'implicit', 'urn:ietf:params:oauth:grant-type:device_code'],
      subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'], revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'], introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true,
      claims_supported: ['sub', 'aud', 'iss', 'exp', 'iat', 'auth_time', 'nonce', 'nickname', 'picture', 'email', 'email_verified', 'selectedProfile', 'availableProfiles'], ...(shared ? { shared_client_id: shared.id } : {}) });
  };
  r.get('/.well-known/openid-configuration', discovery);
  r.get('/.well-known/oauth-authorization-server', discovery);
  // 部分客户端（authlib-injector / Java 启动器）按惯例探测根路径的发现端点，
  // 302 到实际挂载点，避免落进 SPA 404 渲染白耗一次配置查询。
  // 开关检查与 /yggc 子应用内的行为保持一致。跳转允许客户端短缓存：
  // 发现端点轮询量很大（启动器每 15 秒一次），客户端命中后 4 次里省 3 次
  // 源站请求；Worker 响应默认不进 zone 边缘缓存，需要边缘拦截另配 Cache Rule。
  const wellKnownRedirect = (mount: string) => async (c: ConnectContext) => {
    await connectEnabled(c);
    c.header('Cache-Control', 'public, max-age=60');
    return c.redirect(`${issuer(c)}${mount}`, 302);
  };
  app.get('/.well-known/openid-configuration', wellKnownRedirect('/.well-known/openid-configuration'));
  app.get('/.well-known/oauth-authorization-server', wellKnownRedirect('/.well-known/oauth-authorization-server'));
  app.get('/.well-known/openid-configuration/yggc', async c => { await connectEnabled(c); return discovery(c); });
  app.get('/.well-known/oauth-authorization-server/yggc', async c => { await connectEnabled(c); return discovery(c); });
  r.get('/jwks', async c => {
    if (!await c.env.DB.prepare('SELECT kid FROM connect_keys WHERE retired_at IS NULL').first()) await rotateConnectKey(c, true);
    const { results } = await c.env.DB.prepare('SELECT public_jwk FROM connect_keys ORDER BY created_at').all<{ public_jwk: string }>();
    return c.json({ keys: results.map(k => JSON.parse(k.public_jwk)) });
  });
  r.get('/response/:id', async c => {
    const row = await c.env.DB.prepare('DELETE FROM connect_responses WHERE id = ? AND user_id IS ? AND expires_at > ? RETURNING body').bind(await hashToken(c.req.param('id')), c.get('user')?.id ?? null, Date.now()).first<{ body: string }>();
    if (!row) throw new OAuthError('invalid_request', 'Response expired.');
    const body = JSON.parse(row.body) as { uri: string; values: Record<string, string> };
    const escape = (v: string) => v.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
    const nonce = randomSecret();
    const label = (await serviceTranslator(c.env, normalizeLocale(c.get('user')?.locale)))('general.submit');
    c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${new URL(body.uri).origin}; base-uri 'none'; frame-ancestors 'none'`);
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(`<!doctype html><html><head><meta charset="utf-8"></head><body><form method="post" action="${escape(body.uri)}">${Object.entries(body.values).map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join('')}<noscript><button type="submit">${escape(label)}</button></noscript></form><script nonce="${nonce}">document.forms[0].submit()</script></body></html>`);
  });
  r.on(['GET', 'POST'], '/authorize', async c => {
    const search = c.req.method === 'POST' ? await form(c) : new URL(c.req.url).searchParams;
    for (const key of new Set(search.keys())) if (search.getAll(key).length !== 1) throw new OAuthError('invalid_request', 'Duplicate parameter.');
    const params = Object.fromEntries(search);
    const client = await clientById(c, params.client_id || '');
    if (!matchRedirect(client, params.redirect_uri || '')) throw new OAuthError('invalid_request', 'Unregistered redirect URI.');
    try {
      if (!['code', 'id_token', 'code id_token'].includes(params.response_type || '')) throw new OAuthError('unsupported_response_type');
      params.scope ||= 'User.Read';
      const scopes = validateScopes(params.scope);
      await scopesEnabled(c, scopes);
      params.scope = scopes.join(' ');
      params._requested_at = String(Date.now());
      if (params.response_type!.includes('id_token') && !scopes.includes('openid')) throw new OAuthError('invalid_scope', 'ID tokens require openid.');
      if (params.max_age !== undefined && !/^\d{1,9}$/.test(params.max_age)) throw new OAuthError('invalid_request', 'Invalid max_age.');
      if (params.claims || params.request || params.request_uri) throw new OAuthError('request_not_supported', 'Request objects and custom claims are not supported.');
      if (params.response_type!.includes('code') && !client.secret_hash && !params.code_challenge) throw new OAuthError('invalid_request', 'PKCE required.');
      if (params.code_challenge && (params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge))) throw new OAuthError('invalid_request', 'S256 PKCE required.');
      if (params.code_challenge_method && !params.code_challenge) throw new OAuthError('invalid_request', 'PKCE challenge required.');
      if (params.response_type!.includes('id_token') && !params.nonce) throw new OAuthError('invalid_request', 'Nonce required.');
      if (params.response_mode && (!['query', 'fragment', 'form_post'].includes(params.response_mode) || (params.response_type !== 'code' && params.response_mode === 'query'))) throw new OAuthError('invalid_request', 'Unsupported response mode.');
      if (params.response_mode === 'form_post' && !/^https?:/.test(params.redirect_uri!)) throw new OAuthError('invalid_request', 'Form responses require an HTTP callback.');
      if (params.prompt && !['none', 'consent', 'login'].includes(params.prompt)) throw new OAuthError('invalid_request', 'Unsupported prompt.');
      const session = await c.env.DB.prepare('SELECT created_at FROM sessions WHERE id = ?').bind(c.get('sessionId') ?? null).first<{ created_at: number }>();
      const freshRequired = params.prompt === 'login' || params.max_age === '0' || (params.max_age !== undefined && (!session || Date.now() - session.created_at > Number(params.max_age) * 1000));
      let previous: Grant | null = null;
      if (params.prompt === 'none') {
        if (!c.get('user') || freshRequired) throw new OAuthError('login_required');
        const { results } = await c.env.DB.prepare('SELECT * FROM connect_grants WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC').bind(c.get('user')!.id, client.id, Date.now()).all<Grant>();
        for (const candidate of results) {
          if (!scopes.every(s => (JSON.parse(candidate.scopes) as string[]).includes(s))) continue;
          try { previous = await activeGrant(c, candidate.id, client.id); break; } catch { continue; }
        }
        if (!previous) throw new OAuthError('consent_required');
      }
      const raw = randomSecret();
      await c.env.DB.prepare('INSERT INTO connect_interactions (id, client_id, user_id, params, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(await hashToken(raw), client.id, c.get('user')?.id ?? null, JSON.stringify(params), Date.now() + 900000).run();
      const destination = `/connect/authorize/${raw}`;
      if (previous) {
        const row = await interaction(c, raw);
        return c.redirect(await completeAuthorization(c, row, params, scopes.includes('Yggdrasil.PlayerProfiles.Select') ? previous.player_id : null));
      }
      return c.redirect(freshRequired || !c.get('user') ? `/login?redirect=${encodeURIComponent(destination)}` : destination);
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      return c.redirect(await reply(c, { ...params, response_mode: ['query', 'fragment', 'form_post'].includes(params.response_mode || '') ? params.response_mode! : '', response_type: ['code', 'id_token', 'code id_token'].includes(params.response_type || '') ? params.response_type! : 'code' }, { error: error.code, error_description: error.message }));
    }
  });
  r.post('/device_authorization', async c => {
    const params = await form(c), client = await authenticateClient(c, params);
    const scopes = validateScopes(params.get('scope') || 'User.Read');
    await scopesEnabled(c, scopes);
    const deviceCode = randomSecret();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const userCode = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => alphabet[b % alphabet.length]).join('');
    await c.env.DB.prepare('INSERT INTO connect_devices (id, user_code_hash, client_id, scopes, expires_at) VALUES (?, ?, ?, ?, ?)').bind(await hashToken(deviceCode), await hashToken(userCode), client.id, JSON.stringify(scopes), Date.now() + 600000).run();
    const code = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
    return c.json({ device_code: deviceCode, user_code: code, verification_uri: `${c.env.APP_URL.replace(/\/$/, '')}/connect/device`, verification_uri_complete: `${c.env.APP_URL.replace(/\/$/, '')}/connect/device?user_code=${code}`, expires_in: 600, interval: 5 });
  });
  r.post('/token', async c => {
    const params = await form(c), client = await authenticateClient(c, params);
    const type = params.get('grant_type');
    let table: 'connect_codes' | 'connect_refresh' | 'connect_devices';
    let row: Code | Refresh | Device | null;
    let nonce: string | null = null;
    if (type === 'authorization_code') {
      table = 'connect_codes';
      row = await c.env.DB.prepare('SELECT * FROM connect_codes WHERE id = ?').bind(await hashToken(params.get('code') || '')).first<Code>();
      const codeRow = row as Code | null;
      if (!codeRow || codeRow.consumed_at !== null || codeRow.expires_at <= Date.now() || params.get('redirect_uri') !== codeRow.redirect_uri) throw new OAuthError('invalid_grant');
      if (codeRow.challenge) {
        const verifier = params.get('code_verifier') || '';
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) !== codeRow.challenge) throw new OAuthError('invalid_grant', 'Invalid PKCE verifier.');
      }
      nonce = codeRow.nonce;
    } else if (type === 'refresh_token') {
      table = 'connect_refresh';
      row = await c.env.DB.prepare('SELECT * FROM connect_refresh WHERE id = ?').bind(await hashToken(params.get('refresh_token') || '')).first<Refresh>();
      if (!row || row.expires_at <= Date.now()) throw new OAuthError('invalid_grant');
      await activeGrant(c, row.grant_id, client.id);
      if (row.consumed_at !== null) { await revokeGrant(c, row.grant_id); throw new OAuthError('invalid_grant', 'Refresh token was already used.'); }
    } else if (type === 'urn:ietf:params:oauth:grant-type:device_code') {
      table = 'connect_devices';
      row = await c.env.DB.prepare('SELECT * FROM connect_devices WHERE id = ?').bind(await hashToken(params.get('device_code') || '')).first<Device>();
      if (!row || row.client_id !== client.id || row.consumed_at !== null) throw new OAuthError('invalid_grant');
      if (row.expires_at <= Date.now()) throw new OAuthError('expired_token');
      if (row.denied) throw new OAuthError('access_denied');
      const now = Date.now();
      const allowed = await c.env.DB.prepare('UPDATE connect_devices SET next_poll_at = ? WHERE id = ? AND next_poll_at <= ? RETURNING id').bind(now + row.interval_seconds * 1000, row.id, now).first();
      if (!allowed) {
        await c.env.DB.prepare('UPDATE connect_devices SET interval_seconds = interval_seconds + 5, next_poll_at = ? + (interval_seconds + 5) * 1000 WHERE id = ?').bind(now, row.id).run();
        throw new OAuthError('slow_down');
      }
      if (!row.grant_id) throw new OAuthError('authorization_pending');
    } else throw new OAuthError('unsupported_grant_type');
    if (!row) throw new OAuthError('invalid_grant');
    const grant = await activeGrant(c, row.grant_id!, client.id);
    let scopes = JSON.parse(table === 'connect_refresh' ? (row as Refresh).scopes : grant.scopes) as string[];
    if (params.has('scope') && type !== 'refresh_token') throw new OAuthError('invalid_request', 'Scope can only be reduced during refresh.');
    if (params.has('scope')) {
      const requested = validateScopes(params.get('scope')!);
      if (requested.some(scope => !scopes.includes(scope))) throw new OAuthError('invalid_scope');
      scopes = requested;
    }
    await scopesEnabled(c, scopes);
    const bundle = await tokenBundle(c, grant, scopes, nonce);
    const consumeKey = randomSecret(), now = Date.now();
    const result = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE ${table} SET consumed_at = ?, consume_key = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`).bind(now, consumeKey, row.id, now),
      ...bundle.statements(table, row.id, consumeKey),
    ]);
    if (!result[0]?.meta.changes || !result[1]?.meta.changes) {
      if (table === 'connect_refresh') await revokeGrant(c, grant.id);
      throw new OAuthError('invalid_grant');
    }
    return c.json(bundle.response);
  });
  r.on(['GET', 'POST'], '/userinfo', async c => {
    const { grant, scopes } = await verifyConnectToken(c, c.req.header('authorization')?.replace(/^Bearer /i, '') || '', 'openid');
    return c.json(await claimsFor(c, grant, scopes));
  });
  r.post('/revocation', async c => {
    const params = await form(c), client = await authenticateClient(c, params), id = await hashToken(params.get('token') || '');
    if (!params.get('token')) throw new OAuthError('invalid_request', 'Token required.');
    const row = await c.env.DB.prepare('SELECT grant_id FROM connect_refresh WHERE id = ? UNION SELECT grant_id FROM ygg_tokens WHERE id = ? AND source = ?').bind(id, id, 'connect').first<{ grant_id: string }>();
    if (row) {
      const owned = await c.env.DB.prepare('SELECT id FROM connect_grants WHERE id = ? AND client_id = ?').bind(row.grant_id, client.id).first();
      if (owned) await revokeGrant(c, row.grant_id);
    }
    return c.body(null, 200);
  });
  r.post('/introspection', async c => {
    const params = await form(c), client = await authenticateClient(c, params);
    if (!client.secret_hash) throw new OAuthError('invalid_client', 'Confidential client required.', 401);
    if (!params.get('token')) throw new OAuthError('invalid_request', 'Token required.');
    try {
      const raw = params.get('token')!;
      const refresh = await c.env.DB.prepare('SELECT * FROM connect_refresh WHERE id = ? AND consumed_at IS NULL AND expires_at > ?').bind(await hashToken(raw), Date.now()).first<Refresh>();
      const grant = refresh ? await activeGrant(c, refresh.grant_id, client.id) : (await verifyConnectToken(c, raw)).grant;
      if (grant.client_id !== client.id) return c.json({ active: false });
      const access = refresh ? null : await c.env.DB.prepare('SELECT scopes, expires_at FROM ygg_tokens WHERE id = ?').bind(await hashToken(raw)).first<{ scopes: string; expires_at: number }>();
      return c.json({ active: true, client_id: client.id, sub: String(grant.user_id), scope: (JSON.parse(refresh?.scopes ?? access!.scopes) as string[]).join(' '), token_type: refresh ? 'refresh_token' : 'Bearer', exp: Math.floor((refresh?.expires_at ?? access!.expires_at) / 1000), iss: issuer(c), aud: client.id });
    } catch { return c.json({ active: false }); }
  });
  app.route('/yggc', r);
  app.route('/oauth', r);

  const ui = new Hono<AppEnv>();
  ui.onError((error, c) => error instanceof OAuthError ? c.json({ error: error.code, error_description: error.message }, error.status) : (() => { throw error; })());
  ui.use('*', async (c, next) => { await connectEnabled(c); currentUser(c); c.header('Cache-Control', 'no-store'); await next(); });
  ui.get('/interactions/:id', async c => {
    const row = await interaction(c, c.req.param('id'));
    const params = JSON.parse(row.params) as Record<string, string>, client = await clientById(c, row.client_id);
    return c.json({ client: { id: client.id, name: client.name }, scopes: validateScopes(params.scope!), profiles: (await gameProfiles(c, currentUser(c).id)).map(p => ({ ...publicProfile(p), playerId: p.playerId })) });
  });
  ui.post('/interactions/:id', async c => {
    const row = await interaction(c, c.req.param('id')), params = JSON.parse(row.params) as Record<string, string>;
    const body = await readJson(c, z.object({ approve: z.boolean(), playerId: z.number().int().positive().nullable().default(null) }));
    const consumeKey = randomSecret(), now = Date.now();
    if (!body.approve) {
      const done = await c.env.DB.prepare('UPDATE connect_interactions SET consumed_at = ?, consume_key = ? WHERE id = ? AND consumed_at IS NULL RETURNING id').bind(now, consumeKey, row.id).first();
      if (!done) throw new OAuthError('invalid_request');
      return c.json({ redirect: await reply(c, params, { error: 'access_denied' }) });
    }
    return c.json({ redirect: await completeAuthorization(c, row, params, body.playerId ?? null) });
  });
  ui.post('/devices/inspect', async c => {
    const body = await readJson(c, z.object({ userCode: z.string().max(20) }));
    const device = await deviceByCode(c, body.userCode), client = await clientById(c, device.client_id);
    const ticket = randomSecret();
    setCookie(c, 'connect_device', `${await hashToken(ticket)}.${device.id}.${currentUser(c).id}`, { httpOnly: true, secure: c.env.ENVIRONMENT !== 'development', sameSite: 'Strict', path: '/api/v1/connect/devices', maxAge: 600 });
    return c.json({ client: { id: client.id, name: client.name }, scopes: JSON.parse(device.scopes), profiles: (await gameProfiles(c, currentUser(c).id)).map(p => ({ ...publicProfile(p), playerId: p.playerId })), ticket });
  });
  ui.post('/devices/confirm', async c => {
    const body = await readJson(c, z.object({ userCode: z.string().max(20), ticket: z.string(), approve: z.boolean(), playerId: z.number().int().positive().nullable().default(null) }));
    const row = await deviceByCode(c, body.userCode);
    if (getCookie(c, 'connect_device') !== `${await hashToken(body.ticket)}.${row.id}.${currentUser(c).id}`) throw new OAuthError('access_denied', 'Device confirmation is not bound to this session.', 403);
    if (!body.approve) { await c.env.DB.prepare('UPDATE connect_devices SET denied = 1 WHERE id = ? AND grant_id IS NULL').bind(row.id).run(); return c.json({ ok: true }); }
    const grant = await makeGrant(c, row.client_id, JSON.parse(row.scopes) as string[], body.playerId ?? null), consumeKey = randomSecret();
    const result = await c.env.DB.batch([
      c.env.DB.prepare('UPDATE connect_devices SET consume_key = ? WHERE id = ? AND grant_id IS NULL AND denied = 0 AND expires_at > ? AND consume_key IS NULL').bind(consumeKey, row.id, Date.now()),
      insertGrant(c, grant, 'connect_devices', row.id, consumeKey),
      c.env.DB.prepare('UPDATE connect_devices SET grant_id = ?, consume_key = NULL WHERE id = ? AND consume_key = ?').bind(grant.id, row.id, consumeKey),
    ]);
    if (!result[0]?.meta.changes) throw new OAuthError('invalid_request');
    return c.json({ ok: true });
  });
  app.route('/api/v1/connect', ui);

  app.get('/api/v1/me/connect/grants', async c => {
    const user = currentUser(c);
    const { results } = await c.env.DB.prepare('SELECT g.id, c.name AS clientName, p.name AS playerName, g.scopes, g.created_at AS createdAt, g.expires_at AS expiresAt FROM connect_grants g JOIN connect_clients c ON c.id = g.client_id LEFT JOIN players p ON p.id = g.player_id WHERE g.user_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? ORDER BY g.created_at DESC').bind(user.id, Date.now()).all();
    return c.json({ items: results });
  });
  app.delete('/api/v1/me/connect/grants/:id', async c => {
    const user = currentUser(c);
    const row = await c.env.DB.prepare('SELECT id FROM connect_grants WHERE id = ? AND user_id = ?').bind(c.req.param('id'), user.id).first();
    if (row) await revokeGrant(c, c.req.param('id'));
    return c.body(null, 204);
  });
  app.get('/api/v1/admin/connect', async c => {
    currentAdmin(c);
    const { results } = await c.env.DB.prepare('SELECT id, name, redirect_uris AS redirectUris, enabled, shared, secret_hash IS NOT NULL AS confidential FROM connect_clients ORDER BY created_at DESC').all();
    const keys = await c.env.DB.prepare('SELECT kid, created_at AS createdAt, retired_at AS retiredAt FROM connect_keys ORDER BY created_at DESC').all();
    return c.json({ clients: results, keys: keys.results, issuer: issuer(c) });
  });
  app.post('/api/v1/admin/connect/keys', async c => {
    if (currentAdmin(c).role !== 'super_admin') throw new OAuthError('access_denied', 'Super administrator required.', 403);
    return c.json(await rotateConnectKey(c));
  });
  const clientSchema = z.object({ name: z.string().trim().min(1).max(100), redirectUris: z.array(z.string().max(2000).refine(validRedirect)).min(1).max(20), confidential: z.boolean(), shared: z.boolean().default(false) }).refine(v => !v.shared || !v.confidential);
  const patchSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), redirectUris: z.array(z.string().max(2000).refine(validRedirect)).min(1).max(20).optional(), enabled: z.boolean().optional(), shared: z.boolean().optional() });
  function clientRevocations(c: ConnectContext, id: string) {
    return [
      c.env.DB.prepare('UPDATE connect_grants SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL').bind(Date.now(), id),
      c.env.DB.prepare('DELETE FROM ygg_tokens WHERE grant_id IN (SELECT id FROM connect_grants WHERE client_id = ?)').bind(id),
      c.env.DB.prepare('DELETE FROM connect_interactions WHERE client_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM connect_devices WHERE client_id = ?').bind(id),
    ];
  }
  for (const admin of [false, true]) {
    const root = admin ? '/api/v1/admin/connect/clients' : '/api/v1/me/oauth/clients';
    async function ownedClient(c: ConnectContext) {
      const user = admin ? currentAdmin(c) : currentUser(c);
      const row = await c.env.DB.prepare('SELECT * FROM connect_clients WHERE id = ?').bind(c.req.param('id')).first<import('../services/connect.ts').ConnectClient>();
      if (!row || (!admin && row.user_id !== user.id)) throw new OAuthError('invalid_request', 'Application not found.');
      return row;
    }
    app.get(root, async c => {
      const user = admin ? currentAdmin(c) : currentUser(c);
      const { results } = await c.env.DB.prepare('SELECT id, name, redirect_uris AS redirectUris, enabled, shared, user_id AS userId, secret_hash IS NOT NULL AS confidential FROM connect_clients' + (admin ? '' : ' WHERE user_id = ?') + ' ORDER BY created_at DESC').bind(...(admin ? [] : [user.id])).all();
      return c.json({ items: results, issuer: issuer(c) });
    });
    app.post(root, async c => {
      const user = admin ? currentAdmin(c) : currentUser(c);
      await account(c, user.id);
      const body = await readJson(c, clientSchema), id = crypto.randomUUID(), secret = body.confidential ? randomSecret() : null;
      if (!admin && body.shared) throw new OAuthError('access_denied', 'Shared clients require administrator approval.', 403);
      const inserted = await c.env.DB.prepare('INSERT INTO connect_clients (id, name, secret_hash, redirect_uris, shared, user_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ? = 1 OR (SELECT count(*) FROM connect_clients WHERE user_id = ?) < 20 RETURNING id')
        .bind(id, body.name, secret ? await hashToken(secret) : null, JSON.stringify([...new Set(body.redirectUris)]), body.shared ? 1 : 0, admin ? null : user.id, Date.now(), admin ? 1 : 0, user.id).first();
      if (!inserted) throw new OAuthError('invalid_request', 'Application limit reached.');
      return c.json({ id, ...(secret ? { clientSecret: secret } : {}) }, 201);
    });
    app.patch(root + '/:id', async c => {
      const client = await ownedClient(c), body = await readJson(c, patchSchema);
      if (!admin && body.shared !== undefined) throw new OAuthError('access_denied', 'Shared clients require administrator approval.', 403);
      if (body.shared && client.secret_hash) throw new OAuthError('invalid_request', 'Shared clients must be public.');
      const redirects = body.redirectUris ? JSON.stringify([...new Set(body.redirectUris)]) : null;
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE connect_clients SET name = coalesce(?, name), redirect_uris = coalesce(?, redirect_uris), enabled = coalesce(?, enabled), shared = coalesce(?, shared) WHERE id = ?').bind(body.name ?? null, redirects, body.enabled === undefined ? null : Number(body.enabled), body.shared === undefined ? null : Number(body.shared), client.id),
        ...(body.enabled === false || (redirects !== null && redirects !== client.redirect_uris) ? clientRevocations(c, client.id) : []),
      ]);
      return c.json({ ok: true });
    });
    app.post(root + '/:id/secret', async c => {
      const client = await ownedClient(c);
      if (!client.secret_hash) throw new OAuthError('invalid_request', 'Public clients do not have a secret.');
      const secret = randomSecret();
      await c.env.DB.batch([...clientRevocations(c, client.id), c.env.DB.prepare('UPDATE connect_clients SET secret_hash = ? WHERE id = ?').bind(await hashToken(secret), client.id)]);
      return c.json({ id: client.id, clientSecret: secret });
    });
    app.delete(root + '/:id', async c => {
      const client = await ownedClient(c);
      await c.env.DB.batch([...clientRevocations(c, client.id), c.env.DB.prepare('DELETE FROM connect_clients WHERE id = ?').bind(client.id)]);
      return c.body(null, 204);
    });
  }
}
