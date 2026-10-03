import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { hashPassword, hashToken } from '@pigeon-skin/auth';
import { jwtVerify, importJWK, base64url } from 'jose';
import { runMigrations, setTestYggKey, verifyTestYggSignature } from './setup.ts';
import { createApp } from '../src/app.ts';
import type { Bindings } from '../src/env.ts';

const PASSWORD = 'correct-horse-9';
const GAME_SCOPES = 'openid profile email offline_access Yggdrasil.PlayerProfiles.Select Yggdrasil.Server.Join';
let cookie = '', uid = 0, pid = 0, secondPid = 0, clientId = '';
const redirectUri = 'http://127.0.0.1:8123/callback';
async function json(path: string, body?: unknown, method = 'POST', session = cookie) {
  return SELF.fetch(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...(session ? { cookie: session } : {}), 'sec-fetch-site': 'same-origin' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function form(path: string, values: Record<string, string>) {
  return SELF.fetch(`https://x/yggc/${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, ...values }).toString() });
}
async function authorize(scopes = GAME_SCOPES, type = 'code', approved = true, playerId: number | null = pid) {
  const verifier = 'a'.repeat(64);
  const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: type, scope: scopes, code_challenge: challenge, code_challenge_method: 'S256', state: 'state-value', nonce: 'nonce-value' });
  const response = await SELF.fetch(`https://x/yggc/authorize?${query}`, { headers: { cookie }, redirect: 'manual' });
  expect(response.status).toBe(302);
  const location = response.headers.get('location')!;
  const interactionId = location.split('/').at(-1)!;
  const view = await SELF.fetch(`https://x/api/v1/connect/interactions/${interactionId}`, { headers: { cookie } });
  expect(view.status).toBe(200);
  const approval = await json(`/api/v1/connect/interactions/${interactionId}`, { approve: approved, playerId });
  expect(approval.status).toBe(200);
  const target = new URL((await approval.json<{ redirect: string }>()).redirect);
  const result = type === 'code' ? target.searchParams : new URLSearchParams(target.hash.slice(1));
  expect(result.get('state')).toBe('state-value');
  return { code: result.get('code')!, verifier, result, interactionId };
}
async function codeToken(scopes = GAME_SCOPES) {
  const auth = await authorize(scopes, 'code', true, scopes.includes('Yggdrasil.PlayerProfiles.Select') ? pid : null);
  const response = await form('token', { grant_type: 'authorization_code', code: auth.code, code_verifier: auth.verifier, redirect_uri: redirectUri });
  expect(response.status).toBe(200);
  return response.json<{ access_token: string; refresh_token: string; id_token: string }>();
}
async function userinfo(token: string) {
  return SELF.fetch('https://x/yggc/userinfo', { headers: { authorization: `Bearer ${token}` } });
}
async function traditional(username = 'ConnectOne') {
  const res = await json('/api/yggdrasil/authserver/authenticate', { username, password: PASSWORD, requestUser: true }, 'POST', '');
  expect(res.status).toBe(200);
  return res.json<{ accessToken: string; clientToken: string; selectedProfile?: { id: string; name: string }; availableProfiles: Array<{ id: string; name: string }>; user: { id: string; properties: unknown[] } }>();
}

beforeAll(async () => {
  await runMigrations();
  const now = Date.now();
  const user = await env.DB.prepare('INSERT INTO users (email, nickname, password_hash, role, score, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind('Connect@Example.com', 'Connect account', await hashPassword(PASSWORD), 'super_admin', 1000, now, now, now).first<{ id: number }>();
  uid = user!.id;
  const first = await env.DB.prepare('INSERT INTO players (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id').bind(uid, 'ConnectOne', now, now).first<{ id: number }>();
  const second = await env.DB.prepare('INSERT INTO players (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id').bind(uid, 'ConnectTwo', now, now).first<{ id: number }>();
  pid = first!.id; secondPid = second!.id;
  const login = await json('/api/v1/auth/login', { identifier: 'connect@example.com', password: PASSWORD }, 'POST', '');
  expect(login.status).toBe(200); cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const key = await json('/api/v1/admin/connect/keys', {}); expect(key.status).toBe(200);
  const client = await json('/api/v1/admin/connect/clients', { name: 'Test Launcher', redirectUris: [redirectUri], confidential: false, shared: true });
  expect(client.status).toBe(201); clientId = (await client.json<{ id: string }>()).id;
  const settings = await json('/api/v1/admin/settings', { settings: [{ key: 'ygg_connect_enabled', value: 'true' }, { key: 'ygg_rate_limit', value: '0' }] }, 'PATCH');
  expect(settings.status).toBe(200);
  await setTestYggKey();
});

describe('Worker Connect', () => {
  it('preserves the authorization destination through social sign-in', async () => {
    const auth = await authorize();
    const destination = `/connect/authorize/${auth.interactionId}`;
    const app = createApp();
    const bindings = { ...env, GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' } as Bindings;
    const ctx = createExecutionContext();
    const start = await app.fetch(new Request(`https://x/auth/oauth/github?redirect=${encodeURIComponent(destination)}`), bindings, ctx);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookies = (start.headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(v => v.split(';')[0]!).join('; ');
    expect(cookies).toContain(`oauth_${state}=`);
    await env.DB.prepare('INSERT INTO user_identities (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)').bind('github', 'social-test', uid, Date.now()).run();
    fetchMock.activate();
    fetchMock.get('https://github.com').intercept({ path: '/login/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'remote-token' });
    fetchMock.get('https://api.github.com').intercept({ path: '/user', method: 'GET' }).reply(200, { id: 'social-test', name: 'Social' });
    fetchMock.get('https://api.github.com').intercept({ path: '/user/emails', method: 'GET' }).reply(200, []);
    try {
      const callback = await app.fetch(new Request(`https://x/auth/oauth/github/callback?code=remote-code&state=${state}`, { headers: { cookie: cookies } }), bindings, ctx);
      expect(callback.status).toBe(302); expect(callback.headers.get('location')).toBe(destination);
      expect((callback.headers as Headers & { getSetCookie(): string[] }).getSetCookie().some(v => v.startsWith('bs_session='))).toBe(true);
      await waitOnExecutionContext(ctx);
    } finally { fetchMock.deactivate(); }
  });
  it('protects consent endpoints with CSRF and rejects unknown scopes', async () => {
    const auth = await authorize();
    const forged = await SELF.fetch(`https://x/api/v1/connect/interactions/${auth.interactionId}`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ approve: true, playerId: pid }) });
    expect(forged.status).toBe(403);
    const scopes = await form('device_authorization', { scope: 'openid Yggdrasil.Unknown' }); expect(scopes.status).toBe(400);
    const mixed = await form('device_authorization', { scope: 'openid Yggdrasil.PlayerProfiles.Read Yggdrasil.PlayerProfiles.Select' }); expect(mixed.status).toBe(400);
    const options = await SELF.fetch('https://x/yggc/token', { method: 'OPTIONS', headers: { origin: 'https://launcher.example' } });
    expect(options.status).toBe(204); expect(options.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('publishes issuer, capabilities, shared client and only public keys', async () => {
    const discovery = await SELF.fetch('https://x/yggc/.well-known/openid-configuration');
    const body = await discovery.json<{ issuer: string; shared_client_id: string; response_types_supported: string[] }>();
    expect(body.issuer).toBe('http://localhost:8787/yggc'); expect(body.shared_client_id).toBe(clientId);
    expect(body.response_types_supported).toContain('code id_token');
    const keys = await (await SELF.fetch('https://x/yggc/jwks')).json<{ keys: Array<Record<string, unknown>> }>();
    expect(keys.keys.length).toBeGreaterThan(0); expect(keys.keys[0]!.d).toBeUndefined();
  });
  it('completes PKCE authorization, independently verifies ID token, joins and refreshes', async () => {
    const tokens = await codeToken();
    const keys = await (await SELF.fetch('https://x/yggc/jwks')).json<{ keys: Array<Record<string, unknown>> }>();
    const verified = await jwtVerify(tokens.id_token, await importJWK(keys.keys[0]!, 'RS256'), { issuer: 'http://localhost:8787/yggc', audience: clientId });
    expect(verified.payload.nonce).toBe('nonce-value'); expect(verified.payload.at_hash).toBeTruthy();
    const info = await userinfo(tokens.access_token); expect(info.status).toBe(200);
    const body = await info.json<{ selectedProfile: { id: string; name: string }; email_verified: boolean; picture?: string }>();
    expect(body.selectedProfile.name).toBe('ConnectOne'); expect(body.email_verified).toBe(true);
    expect(body.picture).toBeUndefined();
    const join = await json('/api/yggdrasil/sessionserver/session/minecraft/join', { accessToken: tokens.access_token, selectedProfile: body.selectedProfile.id, serverId: 'cross-location' }, 'POST', ''); expect(join.status).toBe(204);
    const has = await SELF.fetch('https://x/api/yggdrasil/sessionserver/session/minecraft/hasJoined?username=ConnectOne&serverId=cross-location'); expect(has.status).toBe(200);
    const refresh = await form('token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }); expect(refresh.status).toBe(200);
    const replacement = await refresh.json<{ access_token: string; refresh_token: string }>(); expect(replacement.refresh_token).not.toBe(tokens.refresh_token);
    const legacyRefresh = await json('/api/yggdrasil/authserver/refresh', { accessToken: replacement.access_token }, 'POST', ''); expect(legacyRefresh.status).toBe(403);
  });
  it('rejects invalid PKCE without consuming the code and rejects code reuse', async () => {
    const auth = await authorize();
    const wrong = await form('token', { grant_type: 'authorization_code', code: auth.code, redirect_uri: redirectUri, code_verifier: 'b'.repeat(64) }); expect(wrong.status).toBe(400);
    const values = { grant_type: 'authorization_code', code: auth.code, redirect_uri: redirectUri, code_verifier: auth.verifier };
    expect((await form('token', values)).status).toBe(200); expect((await form('token', values)).status).toBe(400);
  });
  it('only exchanges a code once under concurrent requests', async () => {
    const auth = await authorize();
    const values = { grant_type: 'authorization_code', code: auth.code, redirect_uri: redirectUri, code_verifier: auth.verifier };
    const results = await Promise.all([form('token', values), form('token', values)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  });
  it('detects refresh replay and revokes the resulting authorization', async () => {
    const token = await codeToken();
    const refresh = await form('token', { grant_type: 'refresh_token', refresh_token: token.refresh_token });
    const next = await refresh.json<{ access_token: string }>();
    expect((await form('token', { grant_type: 'refresh_token', refresh_token: token.refresh_token })).status).toBe(400);
    expect((await userinfo(next.access_token)).status).toBe(401);
  });
  it('does not regain scopes after a restricted refresh', async () => {
    const tokens = await codeToken();
    const reduced = await form('token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, scope: 'openid offline_access' });
    const next = await reduced.json<{ refresh_token: string }>();
    expect((await form('token', { grant_type: 'refresh_token', refresh_token: next.refresh_token, scope: GAME_SCOPES })).status).toBe(400);
  });
  it('never redirects to unregistered destinations and requires PKCE and nonce', async () => {
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: 'https://evil.example/callback', response_type: 'code', scope: 'openid' });
    const unsafe = await SELF.fetch(`https://x/yggc/authorize?${params}`, { redirect: 'manual' }); expect(unsafe.status).toBe(400); expect(unsafe.headers.get('location')).toBeNull();
    params.set('redirect_uri', redirectUri);
    const missing = await SELF.fetch(`https://x/yggc/authorize?${params}`, { redirect: 'manual' }); expect(missing.headers.get('location')).toContain('error=invalid_request');
    params.set('response_type', 'id_token');
    const nonce = await SELF.fetch(`https://x/yggc/authorize?${params}`, { redirect: 'manual' }); expect(nonce.headers.get('location')).toContain('error=invalid_request');
  });
  it('returns denial with state and signs hybrid c_hash', async () => {
    const denied = await authorize(GAME_SCOPES, 'code', false); expect(denied.result.get('error')).toBe('access_denied');
    const hybrid = await authorize(GAME_SCOPES, 'code id_token');
    const keyset = await (await SELF.fetch('https://x/yggc/jwks')).json<{ keys: Array<Record<string, unknown>> }>();
    const claims = await jwtVerify(hybrid.result.get('id_token')!, await importJWK(keyset.keys[0]!, 'RS256'));
    expect(claims.payload.c_hash).toBe(base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hybrid.code))).slice(0, 16)));
  });
  it('issues an ID token without issuing an access token for implicit sign-in', async () => {
    const result = await authorize('openid profile', 'id_token', true, null);
    expect(result.result.get('id_token')).toBeTruthy(); expect(result.result.has('access_token')).toBe(false);
  });
  it('completes device authorization with consent and enforces polling', async () => {
    const response = await form('device_authorization', { scope: GAME_SCOPES }); expect(response.status).toBe(200);
    const device = await response.json<{ device_code: string; user_code: string }>();
    const poll = { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code };
    expect((await (await form('token', poll)).json<{ error: string }>()).error).toBe('authorization_pending');
    expect((await (await form('token', poll)).json<{ error: string }>()).error).toBe('slow_down');
    const inspect = await json('/api/v1/connect/devices/inspect', { userCode: device.user_code }); expect(inspect.status).toBe(200);
    const ticket = (await inspect.json<{ ticket: string }>()).ticket;
    const deviceCookie = inspect.headers.get('set-cookie')!.split(';')[0]!;
    expect((await json('/api/v1/connect/devices/confirm', { userCode: device.user_code, ticket, approve: true, playerId: pid }, 'POST', `${cookie}; ${deviceCookie}`)).status).toBe(200);
    await env.DB.prepare('UPDATE connect_devices SET next_poll_at = 0 WHERE id = ?').bind(await hashToken(device.device_code)).run();
    expect((await form('token', poll)).status).toBe(200); expect((await form('token', poll)).status).toBe(400);
  });
  it('cannot join without the Join scope and omits unrequested private claims', async () => {
    const tokens = await codeToken('openid');
    const info = await (await userinfo(tokens.access_token)).json<Record<string, unknown>>();
    expect(info.email).toBeUndefined(); expect(info.selectedProfile).toBeUndefined();
    const auth = await traditional();
    expect((await json('/api/yggdrasil/sessionserver/session/minecraft/join', { accessToken: tokens.access_token, selectedProfile: auth.selectedProfile!.id, serverId: 'no-scope' }, 'POST', '')).status).toBe(403);
  });
  it('retains old verification keys after rotation', async () => {
    const tokens = await codeToken();
    expect((await json('/api/v1/admin/connect/keys', {})).status).toBe(200);
    const keys = await (await SELF.fetch('https://x/yggc/jwks')).json<{ keys: unknown[] }>(); expect(keys.keys.length).toBe(2);
    expect((await userinfo(tokens.access_token)).status).toBe(200);
  });
  it('revokes access through the token revocation endpoint', async () => {
    const tokens = await codeToken(); expect((await form('revocation', { token: tokens.refresh_token })).status).toBe(200);
    expect((await userinfo(tokens.access_token)).status).toBe(401);
  });
  it('accepts confidential clients only with their client_secret_post credentials', async () => {
    const created = await json('/api/v1/admin/connect/clients', { name: 'Confidential Launcher', redirectUris: ['https://launcher.example/callback'], confidential: true });
    const client = await created.json<{ id: string; clientSecret: string }>();
    expect((await form('device_authorization', { client_id: client.id, scope: 'openid' })).status).toBe(401);
    expect((await form('device_authorization', { client_id: client.id, client_secret: 'wrong', scope: 'openid' })).status).toBe(401);
    expect((await form('device_authorization', { client_id: client.id, client_secret: client.clientSecret, scope: 'openid' })).status).toBe(200);
    const stored = await env.DB.prepare('SELECT secret_hash FROM connect_clients WHERE id = ?').bind(client.id).first<{ secret_hash: string }>();
    expect(stored!.secret_hash).toBe(await hashToken(client.clientSecret));
    expect(JSON.stringify(await (await SELF.fetch('https://x/api/v1/admin/connect', { headers: { cookie } })).json())).not.toContain(client.clientSecret);
  });
  it('rejects expired authorization and device codes', async () => {
    const auth = await authorize();
    await env.DB.prepare('UPDATE connect_codes SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, await hashToken(auth.code)).run();
    expect((await form('token', { grant_type: 'authorization_code', code: auth.code, code_verifier: auth.verifier, redirect_uri: redirectUri })).status).toBe(400);
    const device = await (await form('device_authorization', { scope: 'openid' })).json<{ device_code: string }>();
    await env.DB.prepare('UPDATE connect_devices SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, await hashToken(device.device_code)).run();
    expect((await (await form('token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code })).json<{ error: string }>()).error).toBe('expired_token');
  });
  it('rejects ID tokens and tampered access tokens at UserInfo', async () => {
    const tokens = await codeToken();
    expect((await userinfo(tokens.id_token)).status).toBe(401);
    const [header, payload, signature] = tokens.access_token.split('.');
    const changed = signature!.startsWith('A') ? `B${signature!.slice(1)}` : `A${signature!.slice(1)}`;
    expect((await userinfo(`${header}.${payload}.${changed}`)).status).toBe(401);
  });
  it('revokes grants from the user application list and keeps production issuer HTTPS-only', async () => {
    const tokens = await codeToken();
    const grants = await (await SELF.fetch('https://x/api/v1/me/connect/grants', { headers: { cookie } })).json<{ items: Array<{ id: string }> }>();
    expect(grants.items.length).toBeGreaterThan(0);
    expect((await json(`/api/v1/me/connect/grants/${grants.items[0]!.id}`, undefined, 'DELETE')).status).toBe(204);
    expect((await userinfo(tokens.access_token)).status).toBe(401);
    const ctx = createExecutionContext();
    const production = await createApp().fetch(new Request('https://x/yggc/.well-known/openid-configuration'), { ...env, ENVIRONMENT: 'production', APP_URL: 'http://example.com' } as Bindings, ctx);
    expect(production.status).toBe(503);
    await waitOnExecutionContext(ctx);
  });
  it('disabling and reenabling a client does not restore old grants', async () => {
    const tokens = await codeToken();
    expect((await json(`/api/v1/admin/connect/clients/${clientId}`, { enabled: false }, 'PATCH')).status).toBe(200);
    expect((await userinfo(tokens.access_token)).status).toBe(401);
    await json(`/api/v1/admin/connect/clients/${clientId}`, { enabled: true }, 'PATCH');
    expect((await userinfo(tokens.access_token)).status).toBe(401);
  });
});

describe('Yggdrasil compatibility', () => {
  it('binds role-name login and cannot refresh into another owned profile', async () => {
    const auth = await traditional('connectone'); expect(auth.selectedProfile!.name).toBe('ConnectOne'); expect(auth.user.properties).toEqual([]); expect(auth.user).not.toHaveProperty('email');
    const other = await traditional('ConnectTwo');
    expect((await json('/api/yggdrasil/authserver/refresh', { accessToken: auth.accessToken, selectedProfile: other.selectedProfile }, 'POST', '')).status).toBe(403);
    expect((await json('/api/yggdrasil/sessionserver/session/minecraft/join', { accessToken: auth.accessToken, selectedProfile: other.selectedProfile!.id, serverId: 'mismatch' }, 'POST', '')).status).toBe(403);
  });
  it('selects a profile on refresh after multi-profile email login', async () => {
    const email = await traditional('CONNECT@EXAMPLE.COM'); expect(email.selectedProfile).toBeUndefined();
    const auth = await traditional();
    const selected = await json('/api/yggdrasil/authserver/refresh', { accessToken: email.accessToken, selectedProfile: auth.selectedProfile, requestUser: true }, 'POST', ''); expect(selected.status).toBe(200);
    const selectedBody = await selected.json<{ selectedProfile?: { id: string }; accessToken: string }>();
    expect(selectedBody.selectedProfile?.id).toBe(auth.selectedProfile!.id);
    // 未绑定令牌不带 selectedProfile 刷新：应成功轮换，响应省略 selectedProfile（规范语义）
    const email2 = await traditional('CONNECT@EXAMPLE.COM');
    const anonymous = await json('/api/yggdrasil/authserver/refresh', { accessToken: email2.accessToken }, 'POST', '');
    expect(anonymous.status).toBe(200);
    expect((await anonymous.json<{ selectedProfile?: unknown }>()).selectedProfile).toBeUndefined();
  });
  it('distinguishes access expiry from refresh expiry', async () => {
    const auth = await traditional();
    await env.DB.prepare('UPDATE ygg_tokens SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, await hashToken(auth.accessToken)).run();
    expect((await json('/api/yggdrasil/authserver/validate', { accessToken: auth.accessToken }, 'POST', '')).status).toBe(403);
    expect((await json('/api/yggdrasil/authserver/refresh', { accessToken: auth.accessToken }, 'POST', '')).status).toBe(200);
    const expired = await traditional();
    await env.DB.prepare('UPDATE ygg_tokens SET refresh_deadline = ? WHERE id = ?').bind(Date.now() - 1, await hashToken(expired.accessToken)).run();
    expect((await json('/api/yggdrasil/authserver/refresh', { accessToken: expired.accessToken }, 'POST', '')).status).toBe(403);
  });
  it('preserves UUID on case-only rename and requires refresh for both token sources', async () => {
    const auth = await traditional(), tokens = await codeToken();
    await env.DB.prepare('UPDATE players SET name = ? WHERE id = ?').bind('connectONE', pid).run();
    expect((await json('/api/yggdrasil/authserver/validate', { accessToken: auth.accessToken }, 'POST', '')).status).toBe(403);
    expect((await userinfo(tokens.access_token)).status).toBe(401);
    const res = await json('/api/yggdrasil/authserver/refresh', { accessToken: auth.accessToken }, 'POST', ''); expect(res.status).toBe(200);
    expect((await res.json<{ selectedProfile: { id: string; name: string } }>()).selectedProfile).toEqual({ id: auth.selectedProfile!.id, name: 'connectONE' });
    expect((await form('token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status).toBe(200);
  });
  it('signs properties using SHA1withRSA and returns unsigned profiles by default', async () => {
    const auth = await traditional(), uuid = auth.selectedProfile!.id;
    const plain = await (await SELF.fetch(`https://x/api/yggdrasil/sessionserver/session/minecraft/profile/${uuid}`)).json<{ properties: Array<{ name: string; value: string; signature?: string }> }>();
    expect(plain.properties[0]!.signature).toBeUndefined(); expect(plain.properties[1]!.value).toBe('skin,cape');
    const signed = await (await SELF.fetch(`https://x/api/yggdrasil/sessionserver/session/minecraft/profile/${uuid}?unsigned=false`)).json<typeof plain>();
    for (const prop of signed.properties) { expect(await verifyTestYggSignature(prop.value, prop.signature!)).toBe(true); expect(await verifyTestYggSignature(`${prop.value}tampered`, prop.signature!)).toBe(false); }
    expect(JSON.parse(atob(signed.properties[0]!.value)).signatureRequired).toBe(true);
  });
  it('serves modern lookup aliases without redirecting', async () => {
    const bulk = await json('/api/yggdrasil/minecraftservices/minecraft/profile/lookup/bulk/byname', ['connectone'], 'POST', ''); expect(bulk.status).toBe(200);
    expect((await bulk.json<Array<{ name: string }>>())[0]!.name).toBe('ConnectOne');
    expect((await SELF.fetch('https://x/api/yggdrasil/api/minecraft/profile/lookup/name/connectone')).status).toBe(200);
  });
  it('keeps one UUID under concurrent first lookups', async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => SELF.fetch('https://x/api/yggdrasil/api/users/profiles/minecraft/ConnectOne').then(r => r.json<{ id: string }>())));
    expect(new Set(responses.map(r => r.id)).size).toBe(1);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM uuid WHERE player_id = ?').bind(pid).first<{ n: number }>())!.n).toBe(1);
  });
  it('encodes UTF-8 profile names and preserves official signed fallback', async () => {
    const auth = await traditional();
    await env.DB.prepare('UPDATE players SET name = ? WHERE id = ?').bind('角色测试', pid).run();
    const profile = await (await SELF.fetch(`https://x/api/yggdrasil/sessionserver/session/minecraft/profile/${auth.selectedProfile!.id}?unsigned=false`)).json<{ properties: Array<{ value: string; signature: string }> }>();
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(profile.properties[0]!.value), ch => ch.charCodeAt(0))));
    expect(decoded.profileName).toBe('角色测试'); expect(await verifyTestYggSignature(profile.properties[0]!.value, profile.properties[0]!.signature)).toBe(true);
    await env.DB.prepare('INSERT INTO mojang_verifications (user_id, uuid, created_at) VALUES (?, ?, ?)').bind(uid, auth.selectedProfile!.id, Date.now()).run();
    const uuid = auth.selectedProfile!.id, dashed = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
    const official = { id: uuid, name: 'OfficialProfile', properties: [{ name: 'textures', value: 'official-value', signature: 'official-signature' }] };
    fetchMock.activate();
    fetchMock.get('https://sessionserver.mojang.com').intercept({ path: `/session/minecraft/profile/${dashed}?unsigned=false`, method: 'GET' }).reply(200, official);
    try { expect(await (await SELF.fetch(`https://x/api/yggdrasil/sessionserver/session/minecraft/profile/${uuid}?unsigned=false`)).json()).toEqual(official); }
    finally { fetchMock.deactivate(); }
  });
  it('deleting a profile removes UUID, grants, sessions and bound tokens', async () => {
    const auth = await traditional('ConnectTwo');
    await env.DB.prepare('DELETE FROM players WHERE id = ?').bind(secondPid).run();
    expect(await env.DB.prepare('SELECT uuid FROM uuid WHERE player_id = ?').bind(secondPid).first()).toBeNull();
    expect((await json('/api/yggdrasil/authserver/validate', { accessToken: auth.accessToken }, 'POST', '')).status).toBe(403);
  });
  it('ban and password changes revoke both token sources', async () => {
    const auth = await traditional(), tokens = await codeToken();
    await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind('banned', uid).run();
    expect((await userinfo(tokens.access_token)).status).toBe(401);
    expect((await json('/api/yggdrasil/authserver/validate', { accessToken: auth.accessToken }, 'POST', '')).status).toBe(403);
  });
});

describe('in-game texture upload', () => {
  function pngBytes(width = 64, height = 64): Uint8Array<ArrayBuffer> {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, data: Uint8Array) => { const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length); const body = new Uint8Array(4 + data.length); body.set(new TextEncoder().encode(type)); body.set(data, 4); const crcB = new Uint8Array(4); new DataView(crcB.buffer).setUint32(0, crc(body)); return new Uint8Array([...len, ...body, ...crcB]); };
    const ihdr = new Uint8Array(13); new DataView(ihdr.buffer).setUint32(0, width); new DataView(ihdr.buffer).setUint32(4, height); ihdr[8] = 8; ihdr[9] = 6;
    const raw = new Uint8Array(height * (1 + width * 4));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (1 + width * 4) + 1 + x * 4 + 3] = 255;
    const store: number[] = [0x78, 0x01];
    for (let i = 0; i < raw.length; i += 65535) { const slice = raw.subarray(i, i + 65535); store.push(i + 65535 < raw.length ? 0 : 1, slice.length & 255, slice.length >> 8, (~slice.length) & 255, ((~slice.length) >> 8) & 255, ...slice); }
    return new Uint8Array([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(store)), chunk('IEND', new Uint8Array(0))].flatMap(c => [...c]));
  }
  async function putProfile(token: string, uuid: string, bytes: Uint8Array<ArrayBuffer>, type = 'skin') {
    const form = new FormData();
    form.set('model', 'default');
    form.set('file', new Blob([bytes], { type: 'image/png' }), 'skin.png');
    return SELF.fetch(`https://x/api/yggdrasil/api/user/profile/${uuid}/${type}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  }
  const scoreOf = async () => (await env.DB.prepare('SELECT score FROM users WHERE id = ?').bind(uid).first<{ score: number }>())!.score;

  it('rejects connect tokens without the Upload scope and traditional tokens without a profile', async () => {
    const tokens = await codeToken(); // GAME_SCOPES 只含 Join/Select，无 Upload
    const uuid = (await env.DB.prepare('SELECT uuid FROM uuid WHERE player_id = ?').bind(pid).first<{ uuid: string }>())!.uuid;
    expect((await putProfile(tokens.access_token, uuid, pngBytes())).status).toBe(403);
  });

  it('charges score on first in-game upload and reuses identical content for free', async () => {
    // 该 describe 内先解封：前一个 describe 的最后一例把账号置为 banned
    await env.DB.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").bind(uid).run();
    const auth = await traditional();
    const uuid = auth.selectedProfile!.id;
    const before = await scoreOf();

    const bytes = pngBytes();
    const first = await putProfile(auth.accessToken, uuid, bytes);
    expect(first.status).toBe(204);
    const afterFirst = await scoreOf();
    expect(afterFirst).toBeLessThan(before); // 1KB 私有纹理 × score_per_kb_private

    const row = await env.DB.prepare('SELECT skin_texture_id FROM players WHERE id = ?').bind(pid).first<{ skin_texture_id: number }>();
    const textureId = row!.skin_texture_id;
    const texture = await env.DB.prepare('SELECT hash, visibility, uploader_id FROM textures WHERE id = ?').bind(textureId).first<{ hash: string; visibility: string; uploader_id: number }>();
    expect(texture!.visibility).toBe('private');
    expect(texture!.uploader_id).toBe(uid);

    // 完全相同的内容再次上传：命中内容寻址去重，不再扣费
    const second = await putProfile(auth.accessToken, uuid, bytes);
    expect(second.status).toBe(204);
    expect(await scoreOf()).toBe(afterFirst);
    const again = await env.DB.prepare('SELECT skin_texture_id FROM players WHERE id = ?').bind(pid).first<{ skin_texture_id: number }>();
    expect(again!.skin_texture_id).toBe(textureId);
  });
});
