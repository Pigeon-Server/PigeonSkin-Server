import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { base64url, importJWK, jwtVerify } from 'jose';
import { hashPassword, hashToken } from '@pigeon-skin/auth';
import { runMigrations } from './setup.ts';

let cookie = '', otherCookie = '', uid = 0, clientId = '';
const callback = 'https://client.example/callback';
const verifier = 'a'.repeat(64);
let challenge = '';
async function json(path: string, body?: unknown, method = 'GET', session = cookie) {
  return SELF.fetch(`https://x${path}`, { method, headers: { cookie: session, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function form(path: string, values: Record<string, string>, basic?: string) {
  return SELF.fetch(`https://x/yggc/${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(basic ? { authorization: `Basic ${basic}` } : {}) }, body: new URLSearchParams(values).toString() });
}
function params(extra: Record<string, string> = {}) {
  return new URLSearchParams({ client_id: clientId, redirect_uri: callback, scope: 'User.Read Player.Read offline_access', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'application-state', ...extra });
}
async function authorize(extra: Record<string, string> = {}) {
  const start = await SELF.fetch(`https://x/yggc/authorize?${params(extra)}`, { headers: { cookie }, redirect: 'manual' });
  const id = start.headers.get('location')!.split('/').at(-1)!;
  const approved = await json(`/api/v1/connect/interactions/${id}`, { approve: true }, 'POST');
  expect(approved.status).toBe(200);
  const redirect = (await approved.json<{ redirect: string }>()).redirect;
  return { redirect, id };
}
async function tokens(extra: Record<string, string> = {}, clientSecret?: string) {
  const { redirect } = await authorize(extra);
  const response = await form('token', { client_id: extra.client_id || clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), grant_type: 'authorization_code', code: new URL(redirect).searchParams.get('code')!, code_verifier: verifier, redirect_uri: callback });
  expect(response.status).toBe(200);
  return response.json<{ access_token: string; refresh_token: string; id_token?: string; scope: string }>();
}
async function api(token: string, path: string, body?: unknown, method = 'GET', session = '') {
  return SELF.fetch(`https://x${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: 'https://client.example', ...(session ? { cookie: session } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => {
  await runMigrations();
  challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  for (const [email, name] of [['oauth-owner@example.com', 'Owner'], ['oauth-other@example.com', 'Other']]) {
    const now = Date.now();
    const row = await env.DB.prepare("INSERT INTO users (email, nickname, password_hash, role, score, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, 'normal', 1000, ?, ?, ?) RETURNING id").bind(email!, name!, await hashPassword('oauth-protocol-9'), now, now, now).first<{ id: number }>();
    const login = await json('/api/v1/auth/login', { identifier: email, password: 'oauth-protocol-9' }, 'POST', '');
    const session = login.headers.get('set-cookie')!.split(';')[0]!;
    if (name === 'Owner') { cookie = session; uid = row!.id; } else otherCookie = session;
  }
  const created = await json('/api/v1/me/oauth/clients', { name: 'Community application', redirectUris: [callback], confidential: false }, 'POST');
  expect(created.status).toBe(201); clientId = (await created.json<{ id: string }>()).id;
});

describe('OAuth application API', () => {
  it('issues ordinary OAuth tokens and enforces read scopes without cookie escalation', async () => {
    const token = await tokens(); expect(token.id_token).toBeUndefined(); expect(token.refresh_token).toBeTruthy();
    const me = await api(token.access_token, '/api/v1/me'); expect(me.status).toBe(200);
    const profile = await me.json<Record<string, unknown>>(); expect(profile.id).toBe(uid); expect(profile.passwordHash).toBeUndefined();
    expect((await api(token.access_token, '/api/v1/players')).status).toBe(200);
    expect((await api(token.access_token, '/api/v1/players', { name: 'Unauthorized' }, 'POST', otherCookie)).status).toBe(403);
    expect((await api(token.access_token, '/api/v1/admin/settings')).status).toBe(403);
    expect((await api('invalid', '/api/v1/me', undefined, 'GET', cookie)).status).toBe(401);
    expect(me.headers.get('access-control-allow-origin')).toBe('*');
    expect(me.headers.get('cache-control')).toBe('no-store');
  });
  it('allows player writes only with the requested permission', async () => {
    const token = await tokens({ scope: 'Player.ReadWrite' });
    const created = await api(token.access_token, '/api/v1/players', { name: 'DelegatedPlayer' }, 'POST'); expect(created.status).toBe(201);
    expect((await api(token.access_token, '/api/v1/me')).status).toBe(403);
    expect((await json('/api/v1/players')).status).toBe(200);
  });
  it('does not delegate administrator permissions from an ordinary account', async () => {
    const start = await SELF.fetch(`https://x/yggc/authorize?${params({ scope: 'UsersManagement.Read' })}`, { headers: { cookie }, redirect: 'manual' });
    const id = start.headers.get('location')!.split('/').at(-1)!;
    expect((await json(`/api/v1/connect/interactions/${id}`, { approve: true }, 'POST')).status).toBe(403);
  });
  it('requires ownership for application edits, deletion and secret rotation', async () => {
    expect((await json(`/api/v1/me/oauth/clients/${clientId}`, { name: 'Hijacked' }, 'PATCH', otherCookie)).status).toBe(400);
    expect((await json(`/api/v1/me/oauth/clients/${clientId}`, undefined, 'DELETE', otherCookie)).status).toBe(400);
    expect((await json(`/api/v1/me/oauth/clients/${clientId}/secret`, {}, 'POST', otherCookie)).status).toBe(400);
    const list = await (await json('/api/v1/me/oauth/clients')).json<{ items: Array<{ id: string; secret_hash?: string }> }>();
    expect(list.items[0]!.id).toBe(clientId); expect(list.items[0]!.secret_hash).toBeUndefined();
    expect((await json('/api/v1/me/oauth/clients', { name: 'Shared', redirectUris: [callback], confidential: false, shared: true }, 'POST')).status).toBe(403);
  });
  it('uses Basic client authentication, queries own tokens and revokes on secret reset', async () => {
    const created = await (await json('/api/v1/me/oauth/clients', { name: 'Backend application', redirectUris: [callback], confidential: true }, 'POST')).json<{ id: string; clientSecret: string }>();
    const basic = btoa(`${created.id}:${created.clientSecret}`);
    const auth = await authorize({ client_id: created.id });
    const exchange = await form('token', { grant_type: 'authorization_code', code: new URL(auth.redirect).searchParams.get('code')!, redirect_uri: callback, code_verifier: verifier }, basic);
    expect(exchange.status).toBe(200); const token = await exchange.json<{ access_token: string; refresh_token: string }>();
    const active = await (await form('introspection', { token: token.access_token }, basic)).json<{ active: boolean; client_id: string; scope: string }>();
    expect(active.active).toBe(true); expect(active.client_id).toBe(created.id); expect(active.scope).toContain('User.Read');
    expect((await form('introspection', { token: token.access_token, client_id: 'another-client' }, basic)).status).toBe(401);
    expect((await form('introspection', { token: token.access_token, client_id: created.id, client_secret: created.clientSecret }, basic)).status).toBe(401);
    expect((await form('introspection', { token: token.access_token, client_id: created.id }, basic)).status).toBe(200);
    expect((await form('introspection', { token: token.access_token, client_id: clientId })).status).toBe(401);
    const reset = await json(`/api/v1/me/oauth/clients/${created.id}/secret`, {}, 'POST'); expect(reset.status).toBe(200);
    expect((await api(token.access_token, '/api/v1/me')).status).toBe(401);
    expect((await form('token', { grant_type: 'refresh_token', refresh_token: token.refresh_token }, basic)).status).toBe(401);
    const replacement = btoa(`${created.id}:${(await reset.json<{ clientSecret: string }>()).clientSecret}`);
    expect(await (await form('introspection', { token: token.access_token }, replacement)).json()).toEqual({ active: false });
  });
  it('rotates refresh tokens, prevents scope escalation and revokes replayed grants', async () => {
    const token = await tokens();
    const escalated = await form('token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: token.refresh_token, scope: 'Player.ReadWrite' }); expect(escalated.status).toBe(400);
    const refresh = await form('token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: token.refresh_token, scope: 'User.Read offline_access' }); expect(refresh.status).toBe(200);
    const next = await refresh.json<{ access_token: string; refresh_token: string }>();
    expect(next.refresh_token).not.toBe(token.refresh_token);
    expect((await api(next.access_token, '/api/v1/players')).status).toBe(403);
    expect((await form('token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: token.refresh_token })).status).toBe(400);
    expect((await api(next.access_token, '/api/v1/me')).status).toBe(401);
  });
  it('deleting an application invalidates its tokens and removes consent records', async () => {
    const token = await tokens();
    expect((await json(`/api/v1/me/oauth/clients/${clientId}`, undefined, 'DELETE')).status).toBe(204);
    expect((await api(token.access_token, '/api/v1/me')).status).toBe(401);
    expect(await env.DB.prepare('SELECT id FROM connect_grants WHERE client_id = ?').bind(clientId).first()).toBeNull();
  });
  it('does not redirect to malformed callback addresses and handles duplicate form parameters', async () => {
    const start = await SELF.fetch(`https://x/yggc/authorize?${params({ redirect_uri: 'https://evil.example' })}`, { redirect: 'manual' }); expect(start.status).toBe(400); expect(start.headers.get('location')).toBeNull();
    const duplicate = await SELF.fetch('https://x/yggc/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `client_id=${clientId}&client_id=other&grant_type=authorization_code` }); expect(duplicate.status).toBe(400);
    const options = await SELF.fetch('https://x/api/v1/players', { method: 'OPTIONS', headers: { origin: 'https://client.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization,Content-Type' } }); expect(options.status).toBe(204);
  });
  it('canonicalizes the PHP closet scope typo and rejects ID tokens outside OIDC', async () => {
    const token = await tokens({ scope: 'Closet.ReadWrtie' }); expect(token.scope).toBe('Closet.ReadWrite');
    expect((await api(token.access_token, '/api/v1/closet')).status).toBe(200);
    const invalid = await SELF.fetch(`https://x/yggc/authorize?${params({ response_type: 'id_token', nonce: 'n' })}`, { headers: { cookie }, redirect: 'manual' }); expect(invalid.headers.get('location')).toContain('error=invalid_scope');
  });
});

describe('OpenID Connect', () => {
  it('publishes accurate discovery and independently verifiable ID tokens', async () => {
    const metadata = await (await SELF.fetch('https://x/.well-known/openid-configuration/yggc')).json<{ issuer: string; token_endpoint_auth_methods_supported: string[]; scopes_supported: string[] }>();
    expect(metadata.token_endpoint_auth_methods_supported).toContain('client_secret_basic'); expect(metadata.scopes_supported).toContain('Player.Read');
    const token = await tokens({ scope: 'openid profile email', nonce: 'id-token-nonce' });
    const jwks = await (await SELF.fetch('https://x/yggc/jwks')).json<{ keys: Array<Record<string, unknown>> }>();
    const verified = await jwtVerify(token.id_token!, await importJWK(jwks.keys[0]!, 'RS256'), { issuer: metadata.issuer, audience: clientId });
    expect(verified.payload.sub).toBe(String(uid)); expect(verified.payload.nonce).toBe('id-token-nonce'); expect(verified.payload.auth_time).toBeTruthy();
    const info = await SELF.fetch('https://x/yggc/userinfo', { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, origin: 'https://client.example' } }); expect(info.status).toBe(200); expect((await info.json<{ sub: string }>()).sub).toBe(String(uid));
  });
  it('reuses existing consent for prompt=none but never enlarges it silently', async () => {
    await tokens({ scope: 'openid profile' });
    const silent = await SELF.fetch(`https://x/yggc/authorize?${params({ scope: 'openid', prompt: 'none' })}`, { headers: { cookie }, redirect: 'manual' });
    expect(new URL(silent.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    const enlarged = await SELF.fetch(`https://x/yggc/authorize?${params({ scope: 'openid email', prompt: 'none' })}`, { headers: { cookie }, redirect: 'manual' }); expect(enlarged.headers.get('location')).toContain('error=consent_required');
    const anonymous = await SELF.fetch(`https://x/yggc/authorize?${params({ scope: 'openid', prompt: 'none' })}`, { redirect: 'manual' }); expect(anonymous.headers.get('location')).toContain('error=login_required');
  });
  it('requires actual fresh authentication for prompt=login', async () => {
    await env.DB.prepare('UPDATE sessions SET created_at = created_at - 60000 WHERE id = ?').bind(await hashToken(cookie.split('=')[1]!)).run();
    const start = await SELF.fetch(`https://x/yggc/authorize?${params({ scope: 'openid', prompt: 'login' })}`, { headers: { cookie }, redirect: 'manual' });
    const destination = new URL('https://x' + start.headers.get('location')).searchParams.get('redirect')!;
    const id = destination.split('/').at(-1)!;
    const blocked = await json(`/api/v1/connect/interactions/${id}`, { approve: true }, 'POST'); expect((await blocked.json<{ error: string }>()).error).toBe('login_required');
    const login = await json('/api/v1/auth/login', { identifier: 'oauth-owner@example.com', password: 'oauth-protocol-9' }, 'POST');
    const fresh = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await json(`/api/v1/connect/interactions/${id}`, { approve: true }, 'POST', fresh)).status).toBe(200);
  });
  it('returns form_post through a one-time, session-bound HTML response', async () => {
    const auth = await authorize({ scope: 'openid', response_mode: 'form_post', state: '<unsafe>"' });
    expect(auth.redirect).toMatch(/^\/yggc\/response\//);
    expect((await SELF.fetch('https://x' + auth.redirect, { headers: { cookie: otherCookie } })).status).toBe(400);
    const response = await SELF.fetch('https://x' + auth.redirect, { headers: { cookie } }); expect(response.status).toBe(200);
    const html = await response.text(); expect(html).toContain('method="post"'); expect(html).toContain('https://client.example/callback'); expect(html).toContain('&lt;unsafe&gt;&quot;'); expect(html).not.toContain('<unsafe>');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer'); expect(response.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    expect((await SELF.fetch('https://x' + auth.redirect, { headers: { cookie } })).status).toBe(400);
  });
  it('accepts max_age=0 after fresh authentication without requiring an impossible zero-millisecond session age', async () => {
    const start = await form('authorize', Object.fromEntries(params({ scope: 'openid', max_age: '0' })));
    const destination = new URL('https://x' + start.headers.get('location')).searchParams.get('redirect')!;
    const id = destination.split('/').at(-1)!;
    expect((await json(`/api/v1/connect/interactions/${id}`, { approve: true }, 'POST')).status).toBe(400);
    const login = await json('/api/v1/auth/login', { identifier: 'oauth-owner@example.com', password: 'oauth-protocol-9' }, 'POST');
    const session = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await json(`/api/v1/connect/interactions/${id}`, { approve: true }, 'POST', session)).status).toBe(200);
  });
  it('keeps a simple application rename authorized but revokes grants when callbacks change', async () => {
    const token = await tokens();
    expect((await json(`/api/v1/me/oauth/clients/${clientId}`, { name: 'Renamed application', redirectUris: [callback] }, 'PATCH')).status).toBe(200);
    expect((await api(token.access_token, '/api/v1/me')).status).toBe(200);
    expect((await json(`/api/v1/me/oauth/clients/${clientId}`, { redirectUris: ['https://client.example/new-callback'] }, 'PATCH')).status).toBe(200);
    expect((await api(token.access_token, '/api/v1/me')).status).toBe(401);
  });
  it('bounds refreshed token lifetimes by the remaining grant lifetime', async () => {
    const token = await tokens();
    await env.DB.prepare('UPDATE connect_grants SET expires_at = ?').bind(Date.now() + 90000).run();
    const response = await form('token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: token.refresh_token });
    expect(response.status).toBe(200);
    const next = await response.json<{ expires_in: number }>(); expect(next.expires_in).toBeGreaterThan(0); expect(next.expires_in).toBeLessThanOrEqual(90);
  });
});
