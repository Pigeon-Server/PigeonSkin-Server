import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env, SELF, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { hashPassword, hashToken } from '@pigeon-skin/auth';
import { createApp } from '../src/app.ts';
import type { Bindings } from '../src/env.ts';
import { runMigrations } from './setup.ts';

let uid = 0, cookie = '';
const bindings = () => ({ ...env, GITHUB_CLIENT_ID: 'test-github', GITHUB_CLIENT_SECRET: 'github-secret', LITTLESKIN_CLIENT_ID: 'test-little', LITTLESKIN_CLIENT_SECRET: 'little-secret', MICROSOFT_CLIENT_ID: 'test-microsoft', MICROSOFT_CLIENT_SECRET: 'microsoft-secret' }) as Bindings;
async function get(path: string, session = '') {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(new Request('https://x' + path, { headers: { cookie: session } }), bindings(), ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function json(path: string, body: unknown, session: string) {
  return SELF.fetch('https://x' + path, { method: 'POST', headers: { cookie: session, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function cookies(response: Response) { return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(v => v.split(';')[0]!).join('; '); }
async function begin(provider = 'github', session = '') {
  const start = await get(`/auth/oauth/${provider}`, session);
  const url = new URL(start.headers.get('location')!);
  return { state: url.searchParams.get('state')!, url, session: [session, cookies(start)].filter(Boolean).join('; ') };
}
async function finish(auth: Awaited<ReturnType<typeof begin>>, provider = 'github', suffix = 'code=remote-code') {
  return get(`/auth/oauth/${provider}/callback?state=${auth.state}&${suffix}`, auth.session);
}
function github(id: number, email: string | null = 'remote@example.com', verified = true) {
  fetchMock.activate(); fetchMock.disableNetConnect();
  fetchMock.get('https://github.com').intercept({ path: '/login/oauth/access_token', method: 'POST' }).reply(200, { access_token: 'github-token' });
  fetchMock.get('https://api.github.com').intercept({ path: '/user', method: 'GET' }).reply(200, { id, email: null, name: 'Remote player' });
  fetchMock.get('https://api.github.com').intercept({ path: '/user/emails', method: 'GET' }).reply(200, email ? [{ email, verified, primary: true }] : []);
}
beforeAll(async () => {
  await runMigrations();
  const now = Date.now();
  const row = await env.DB.prepare("INSERT INTO users (email, nickname, password_hash, role, score, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, 'normal', 1000, ?, ?, ?) RETURNING id").bind('owner@example.com', 'Local owner', await hashPassword('social-password-9'), now, now, now).first<{ id: number }>();
  uid = row!.id;
  const login = await json('/api/v1/auth/login', { identifier: 'owner@example.com', password: 'social-password-9' }, '');
  cookie = cookies(login);
});
afterEach(() => { fetchMock.deactivate(); });

describe('Third-party authorization', () => {
  it('uses provider-specific URLs, scopes and PKCE rather than the obsolete endpoints', async () => {
    const gh = await begin(); expect(gh.url.searchParams.get('code_challenge_method')).toBe('S256'); expect(gh.url.searchParams.get('scope')).toBe('read:user user:email');
    const little = await begin('littleskin'); expect(little.url.origin + little.url.pathname).toBe('https://littleskin.cn/oauth/authorize'); expect(little.url.searchParams.get('scope')).toBe('User.Read'); expect(little.url.searchParams.has('code_challenge')).toBe(false);
    const ms = await begin('microsoft'); expect(ms.url.hostname).toBe('login.microsoftonline.com'); expect(ms.url.pathname).toBe('/consumers/oauth2/v2.0/authorize'); expect(ms.url.searchParams.get('scope')).toContain('email'); expect(ms.url.searchParams.has('nonce')).toBe(true);
  });
  it('registers from the private verified GitHub email and never invents a usable password', async () => {
    const auth = await begin(); github(101);
    const response = await finish(auth); expect(response.headers.get('location')).toBe('/auth/initialize?redirect=%2Fuser');
    let session = cookies(response);
    const user = await env.DB.prepare('SELECT id, email_verified_at, password_hash FROM users WHERE email = ?').bind('remote@example.com').first<{ id: number; email_verified_at: number; password_hash: string }>();
    expect(user!.email_verified_at).toBeTruthy(); expect(user!.password_hash).toBe('');
    const status = await (await get('/api/v1/auth/initialize', session)).json<{ needsInitialization: boolean; ticket: string }>();
    expect(status.needsInitialization).toBe(true);
    expect((await json('/api/v1/me/oauth/github/unbind', {}, session)).status).toBe(403);
    const initialized = await json('/api/v1/auth/initialize', { ticket: status.ticket, nickname: 'Remote player', email: 'remote@example.com', password: 'new-social-password-9', playerName: 'RemotePlayer' }, session);
    expect(initialized.status).toBe(200); session = cookies(initialized);
    expect((await json('/api/v1/me/oauth/github/unbind', {}, session)).status).toBe(200);
    const login = await json('/api/v1/auth/login', { identifier: 'remote@example.com', password: 'new-social-password-9' }, ''); expect(login.status).toBe(200);
    fetchMock.assertNoPendingInterceptors();
  });
  it('handles LittleSkin uid and its actual token endpoint', async () => {
    const auth = await begin('littleskin');
    fetchMock.activate(); fetchMock.disableNetConnect();
    fetchMock.get('https://littleskin.cn').intercept({ path: '/oauth/token', method: 'POST' }).reply(200, { access_token: 'little-token' });
    fetchMock.get('https://littleskin.cn').intercept({ path: '/api/user', method: 'GET' }).reply(200, { uid: 102, nickname: 'Little player', email: 'little@example.com', verified: true });
    const response = await finish(auth, 'littleskin'); expect(response.headers.get('location')).toBe('/auth/initialize?redirect=%2Fuser');
    const row = await env.DB.prepare('SELECT provider_user_id FROM user_identities WHERE provider = ?').bind('littleskin').first<{ provider_user_id: string }>(); expect(row!.provider_user_id).toBe('102');
    fetchMock.assertNoPendingInterceptors();
  });
  it('requires a verified Microsoft ID token before linking a local email', async () => {
    const auth = await begin('microsoft');
    fetchMock.activate(); fetchMock.disableNetConnect();
    fetchMock.get('https://login.microsoftonline.com').intercept({ path: '/consumers/oauth2/v2.0/token', method: 'POST' }).reply(200, { access_token: 'graph-token' });
    fetchMock.get('https://graph.microsoft.com').intercept({ path: '/v1.0/me', method: 'GET' }).reply(200, { id: 'ms-user', mail: 'owner@example.com', displayName: 'Microsoft account' });
    const response = await finish(auth, 'microsoft'); expect(response.headers.get('location')).toContain('auth.oauth_link_required');
    expect(await env.DB.prepare('SELECT 1 FROM user_identities WHERE provider = ?').bind('microsoft').first()).toBeNull();
    expect(cookies(response)).not.toContain('bs_session='); fetchMock.assertNoPendingInterceptors();
  });
  it('merges only when both the provider and existing account have verified the email', async () => {
    const auth = await begin(); github(103, 'owner@example.com');
    const response = await finish(auth); expect(response.headers.get('location')).toBe('/user');
    const session = await get('/api/v1/auth/session', cookies(response)); expect((await session.json<{ id: number }>()).id).toBe(uid);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>())!.n).toBe(1);
  });
  it('requires explicit linking for a locally unverified matching email', async () => {
    await env.DB.prepare('UPDATE users SET email_verified_at = NULL WHERE id = ?').bind(uid).run();
    const auth = await begin(); github(104, 'owner@example.com');
    expect((await finish(auth)).headers.get('location')).toContain('auth.oauth_link_required');
    expect(await env.DB.prepare('SELECT 1 FROM user_identities').first()).toBeNull();
  });
  it('keeps unverified GitHub emails from being used to identify an existing user', async () => {
    const auth = await begin(); github(105, 'owner@example.com', false);
    const response = await finish(auth); expect(response.headers.get('location')).toBe('/auth/initialize?redirect=%2Fuser');
    const user = await (await get('/api/v1/auth/session', cookies(response))).json<{ id: number; emailVerified: boolean; email: string }>();
    expect(user.id).not.toBe(uid); expect(user.emailVerified).toBe(false); expect(user.email).toMatch(/@oauth.invalid$/);
  });
  it('binds state to the provider, browser and current local session, then consumes it once', async () => {
    const auth = await begin('github', cookie);
    const other = { ...auth, session: cookie + '; oauth_' + auth.state + '=wrong-browser' };
    expect((await finish(other)).headers.get('location')).toContain('auth.oauth_failed');
    expect((await finish(auth, 'microsoft')).headers.get('location')).toContain('auth.oauth_failed');
    expect((await finish({ ...auth, session: auth.session.replace(cookie + '; ', '') })).headers.get('location')).toContain('auth.oauth_failed');
    github(106, 'different@example.com');
    expect((await finish(auth)).headers.get('location')).toBe('/profile?oauth_success=1');
    expect((await finish(auth)).headers.get('location')).toContain('auth.oauth_failed');
    fetchMock.assertNoPendingInterceptors();
  });
  it('allows independent browser tabs without overwriting another authorization state', async () => {
    const one = await begin('github', cookie), two = await begin('github', cookie);
    expect(one.state).not.toBe(two.state);
    github(107);
    expect((await finish(one)).headers.get('location')).toBe('/profile?oauth_success=1');
    const cancelled = await finish(two, 'github', 'error=access_denied'); expect(cancelled.headers.get('location')).toContain('auth.oauth_denied');
    expect(await env.DB.prepare('SELECT id FROM oauth_login_states').first()).toBeNull();
  });
  it('rejects expired states and remote token errors without creating an account', async () => {
    const expired = await begin();
    await env.DB.prepare('UPDATE oauth_login_states SET expires_at = 0 WHERE id = ?').bind(await hashToken(expired.state)).run();
    expect((await finish(expired)).headers.get('location')).toContain('auth.oauth_failed');
    const auth = await begin(); fetchMock.activate(); fetchMock.disableNetConnect();
    fetchMock.get('https://github.com').intercept({ path: '/login/oauth/access_token', method: 'POST' }).reply(200, { error: 'bad_verification_code' });
    expect((await finish(auth)).headers.get('location')).toContain('auth.oauth_failed');
    expect((await env.DB.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>())!.n).toBe(1);
  });
  it('refuses to bind an identity already owned by another local user', async () => {
    const now = Date.now();
    const row = await env.DB.prepare("INSERT INTO users (email, nickname, password_hash, created_at, updated_at) VALUES ('second@example.com', 'Second', '', ?, ?) RETURNING id").bind(now, now).first<{ id: number }>();
    await env.DB.prepare('INSERT INTO user_identities VALUES (?, ?, ?, ?)').bind('github', '108', row!.id, now).run();
    const auth = await begin('github', cookie); github(108);
    expect((await finish(auth)).headers.get('location')).toContain('auth.oauth_identity_taken');
    expect((await (await get('/api/v1/auth/session', cookie)).json<{ id: number }>()).id).toBe(uid);
  });
  it('issues a fresh session when an already signed-in user repeats social login for application authorization', async () => {
    await env.DB.prepare('INSERT INTO user_identities VALUES (?, ?, ?, ?)').bind('github', '109', uid, Date.now()).run();
    const start = await get('/auth/oauth/github?redirect=%2Fconnect%2Fauthorize%2Finteraction', cookie);
    const auth = { state: new URL(start.headers.get('location')!).searchParams.get('state')!, session: cookie + '; ' + cookies(start), url: new URL(start.headers.get('location')!) };
    github(109);
    const callback = await finish(auth); expect(callback.headers.get('location')).toBe('/connect/authorize/interaction');
    expect(cookies(callback)).toContain('bs_session='); expect(cookies(callback)).not.toContain(cookie);
  });
});
