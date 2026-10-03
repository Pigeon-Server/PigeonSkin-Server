import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { hashPassword, hashToken, verifyStoredPassword } from '@pigeon-skin/auth';
import { createSession } from '../src/lib.ts';
import type { Bindings } from '../src/env.ts';
import { runMigrations, mintRawToken } from './setup.ts';

let uid = 0, cookie = '', otherCookie = '', adminCookie = '';
const pendingEmail = 'oauth-init@example.com';
async function request(path: string, body?: unknown, method = 'GET', session = cookie, origin?: string) {
  return SELF.fetch('https://x' + path, { method, headers: { cookie: session, 'content-type': 'application/json', ...(origin ? { origin } : { 'sec-fetch-site': 'same-origin' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function status(session = cookie) { return (await request('/api/v1/auth/initialize', undefined, 'GET', session)).json<{ ticket: string; email: string; emailVerified: boolean; needsInitialization: boolean; playerRequired: boolean }>(); }
async function payload(extra: Record<string, unknown> = {}) { return { ticket: (await status()).ticket, nickname: 'Initialized player', email: pendingEmail, password: 'initialized-password-9', playerName: 'InitializedOne', redirect: '/user', ...extra }; }
function sessionCookie(response: Response) { return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie().find(v => v.startsWith('bs_session='))!.split(';')[0]!; }
beforeAll(async () => {
  await runMigrations();
  const now = Date.now();
  for (const [email, hash, role] of [[pendingEmail, '', 'normal'], ['second-init@oauth.invalid', '', 'normal'], ['init-admin@example.com', await hashPassword('initialization-admin-9'), 'super_admin']]) {
    const row = await env.DB.prepare('INSERT INTO users (email, nickname, password_hash, role, score, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1000, ?, ?, ?) RETURNING id').bind(email!, 'OAuth player', hash!, role!, now, now, now).first<{ id: number }>();
    const session = await createSession(env as Bindings, row!.id, {});
    if (email === pendingEmail) { uid = row!.id; cookie = 'bs_session=' + session.token; }
    else if (role === 'super_admin') adminCookie = 'bs_session=' + session.token;
    else otherCookie = 'bs_session=' + session.token;
  }
  await env.DB.prepare('INSERT INTO user_identities (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)').bind('github', 'initializing-player', uid, now).run();
  await env.DB.prepare('UPDATE users SET needs_initialization = 1 WHERE id = ?').bind(uid).run();
});

describe('OAuth account initialization', () => {
  it('allows language and appearance preferences before setup without opening profile edits', async () => {
    const saved = await request('/api/v1/me/preferences', { locale: 'en', isDarkMode: true }, 'PATCH');
    expect(saved.status).toBe(200);
    const session = await (await request('/api/v1/auth/session')).json<{ locale: string; isDarkMode: boolean; needsInitialization: boolean }>();
    expect(session.locale).toBe('en'); expect(session.isDarkMode).toBe(true); expect(session.needsInitialization).toBe(true);
    const rejected = await request('/api/v1/me/preferences', { locale: 'zh_CN', email: 'other@example.com' }, 'PATCH');
    expect(rejected.status).toBe(422);
    expect((await request('/api/v1/me/preferences', { locale: 'invalid' }, 'PATCH')).status).toBe(422);
    expect((await request('/api/v1/me', { nickname: 'Skipped setup' }, 'PATCH')).status).toBe(403);
    expect((await request('/api/v1/me/preferences', { locale: 'en' }, 'PATCH', '')).status).toBe(401);
    const account = await env.DB.prepare('SELECT email, nickname, password_hash, score, locale FROM users WHERE id = ?').bind(uid).first();
    expect(account).toMatchObject({ email: pendingEmail, nickname: 'OAuth player', password_hash: '', score: 1000, locale: 'en' });
  });
  it('exposes initialization status without exposing credential hashes and blocks skipping setup', async () => {
    const response = await request('/api/v1/auth/initialize');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json<Record<string, unknown>>(); expect(body.needsInitialization).toBe(true); expect(body.playerRequired).toBe(true); expect(body.password_hash).toBeUndefined();
    expect((await (await request('/api/v1/auth/session')).json<{ needsInitialization: boolean }>()).needsInitialization).toBe(true);
    expect((await request('/api/v1/players')).status).toBe(403);
    expect((await request('/api/v1/me/password', { currentPassword: '', newPassword: 'another-password-9' }, 'POST')).status).toBe(403);
    expect((await request('/api/v1/textures')).status).toBe(200);
    expect((await request('/api/v1/auth/initialize', undefined, 'GET', '')).status).toBe(401);
  });
  it('creates the first player, preserves verified email and score, and rotates the session', async () => {
    const body = await payload({ redirect: '/connect/authorize/preserved-interaction' });
    const completed = await request('/api/v1/auth/initialize', body, 'POST'); expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ redirect: '/connect/authorize/preserved-interaction', needsEmailVerification: false });
    const freshCookie = sessionCookie(completed); expect(freshCookie).not.toBe(cookie);
    expect((await request('/api/v1/auth/session')).status).toBe(401);
    const session = await (await request('/api/v1/auth/session', undefined, 'GET', freshCookie)).json<{ needsInitialization: boolean; score: number; emailVerified: boolean; nickname: string }>();
    expect(session.needsInitialization).toBe(false); expect(session.score).toBe(1000); expect(session.emailVerified).toBe(true); expect(session.nickname).toBe('Initialized player');
    const user = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(uid).first<{ password_hash: string }>(); expect(await verifyStoredPassword(body.password, user!.password_hash)).toBe(true);
    const players = await env.DB.prepare('SELECT name FROM players WHERE user_id = ?').bind(uid).all<{ name: string }>(); expect(players.results).toEqual([{ name: 'InitializedOne' }]);
    expect((await request('/api/v1/auth/initialize', { ...body, password: 'cannot-overwrite-9' }, 'POST', freshCookie)).status).toBe(409);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM players WHERE user_id = ?').bind(uid).first<{ n: number }>())!.n).toBe(1);
  });
  it('does not inherit verification when the user chooses a different email', async () => {
    const completed = await request('/api/v1/auth/initialize', await payload({ email: 'changed@example.com' }), 'POST'); expect(completed.status).toBe(200);
    const row = await env.DB.prepare('SELECT email, email_verified_at FROM users WHERE id = ?').bind(uid).first<{ email: string; email_verified_at: number | null }>(); expect(row).toEqual({ email: 'changed@example.com', email_verified_at: null });
  });
  it('preserves verification for a case-only email change', async () => {
    const completed = await request('/api/v1/auth/initialize', await payload({ email: pendingEmail.toUpperCase() }), 'POST'); expect(completed.status).toBe(200);
    expect((await env.DB.prepare('SELECT email_verified_at FROM users WHERE id = ?').bind(uid).first<{ email_verified_at: number }>())!.email_verified_at).toBeTruthy();
  });
  it('rejects placeholder emails, short passwords and invalid players before mutating the user', async () => {
    for (const extra of [{ email: 'still@oauth.invalid' }, { email: 'still@oauth.local' }, { password: 'short' }, { playerName: 'bad player' }]) {
      const result = await request('/api/v1/auth/initialize', await payload(extra), 'POST'); expect(result.status).toBe(422);
    }
    expect((await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(uid).first<{ password_hash: string }>())!.password_hash).toBe('');
    expect(await env.DB.prepare('SELECT id FROM players WHERE user_id = ?').bind(uid).first()).toBeNull();
  });
  it('keeps the account pending when its chosen email or player name is already in use', async () => {
    expect((await request('/api/v1/auth/initialize', await payload({ email: 'init-admin@example.com' }), 'POST')).status).toBe(409);
    await env.DB.prepare('INSERT INTO players (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(uid + 1, 'TakenPlayer', Date.now(), Date.now()).run();
    expect((await request('/api/v1/auth/initialize', await payload({ playerName: 'takenplayer' }), 'POST')).status).toBe(409);
    expect((await status()).needsInitialization).toBe(true);
  });
  it('binds the setup form to the account and exact session, and rejects expired tickets', async () => {
    const body = await payload();
    expect((await request('/api/v1/auth/initialize', body, 'POST', otherCookie)).status).toBe(409);
    const fresh = await createSession(env as Bindings, uid, {});
    expect((await request('/api/v1/auth/initialize', body, 'POST', 'bs_session=' + fresh.token)).status).toBe(409);
    await env.DB.prepare('UPDATE oauth_login_states SET expires_at = 0 WHERE id = ?').bind(await hashToken(body.ticket)).run();
    expect((await request('/api/v1/auth/initialize', body, 'POST')).status).toBe(409);
    expect((await status()).needsInitialization).toBe(true);
  });
  it('enforces CSRF even with an otherwise valid initialization form', async () => {
    const result = await request('/api/v1/auth/initialize', await payload(), 'POST', cookie, 'https://evil.example'); expect(result.status).toBe(403);
    expect((await status()).needsInitialization).toBe(true);
  });
  it('commits only once when two initialization requests race', async () => {
    const body = await payload();
    const results = await Promise.all([request('/api/v1/auth/initialize', body, 'POST'), request('/api/v1/auth/initialize', body, 'POST')]);
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status !== 200).every(r => r.status === 401 || r.status === 409)).toBe(true);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM players WHERE user_id = ?').bind(uid).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare('SELECT score FROM users WHERE id = ?').bind(uid).first<{ score: number }>())!.score).toBe(1000);
  });
  it('never redirects initialization to another origin', async () => {
    const completed = await request('/api/v1/auth/initialize', await payload({ redirect: '//evil.example' }), 'POST'); expect(completed.status).toBe(200);
    expect((await completed.json<{ redirect: string }>()).redirect).toBe('/user');
  });
  it('respects email verification and optional player registration settings', async () => {
    const settings = await request('/api/v1/admin/settings', { settings: [{ key: 'register_with_player_name', value: false }, { key: 'require_email_verification', value: true }] }, 'PATCH', adminCookie); expect(settings.status).toBe(200);
    expect((await status()).playerRequired).toBe(false);
    const completed = await request('/api/v1/auth/initialize', await payload({ email: 'verify-new@example.com', playerName: undefined }), 'POST'); expect(completed.status).toBe(200);
    expect((await completed.json<{ needsEmailVerification: boolean }>()).needsEmailVerification).toBe(true);
    const fresh = sessionCookie(completed), current = await status(fresh); expect(current.needsInitialization).toBe(false); expect(current.emailVerified).toBe(false);
    expect(await env.DB.prepare('SELECT id FROM players WHERE user_id = ?').bind(uid).first()).toBeNull();
  });
  it('does not create another free player for an older incomplete account that already has one', async () => {
    await env.DB.prepare('INSERT INTO players (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(uid, 'ExistingOne', Date.now(), Date.now()).run();
    expect((await status()).playerRequired).toBe(false);
    expect((await request('/api/v1/auth/initialize', await payload(), 'POST')).status).toBe(200);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM players WHERE user_id = ?').bind(uid).first<{ n: number }>())!.n).toBe(1);
  });
  it('keeps the initialization requirement after a password reset', async () => {
    const token = await mintRawToken(uid);
    const reset = await request('/api/v1/auth/reset-password', { token, password: 'reset-before-setup-9' }, 'POST', ''); expect(reset.status).toBe(200);
    const login = await request('/api/v1/auth/login', { identifier: pendingEmail, password: 'reset-before-setup-9' }, 'POST', ''); expect(login.status).toBe(200);
    const session = sessionCookie(login);
    expect((await status(session)).needsInitialization).toBe(true);
    expect((await request('/api/v1/players', undefined, 'GET', session)).status).toBe(403);
  });
});
