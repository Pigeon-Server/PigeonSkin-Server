import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { hashPassword, hashToken } from '@pigeon-skin/auth';
import { base64url } from 'jose';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { createApp } from '../src/app.ts';
import type { Bindings } from '../src/env.ts';
import { createSession, sessionCookieName } from '../src/lib.ts';
import { base32, decryptSecret, encryptSecret, totp, matchingStep } from '../src/services/security-crypto.ts';
import { state } from '../src/repositories/security.ts';
import { runMigrations, mintRawToken } from './setup.ts';

const password = 'correct-horse-9';
const key = base64url.encode(new Uint8Array(32).fill(7));
const bindings = (): Bindings => ({ ...env, APP_URL: 'https://x', MFA_ENCRYPTION_KEY: key, RESEND_API_KEY: 'mail-test', GITHUB_CLIENT_ID: 'github-test', GITHUB_CLIENT_SECRET: 'secret' }) as Bindings;
let uid: number, email: string, cookie: string;
async function call(path: string, body?: unknown, session = cookie, method = body === undefined ? 'GET' : 'POST', override: Partial<Bindings> = {}, origin = 'https://x') {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(new Request(origin + path, { method, headers: { cookie: session, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'cf-connecting-ip': '127.0.0.12' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...bindings(), ...override }, ctx);
  await waitOnExecutionContext(ctx); return response;
}
function cookies(response: Response) {
  return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie().map(v => v.split(';')[0]!).join('; ');
}
async function user(address: string) {
  const now = Date.now();
  return (await env.DB.prepare("INSERT INTO users (email, nickname, password_hash, role, email_verified_at, created_at, updated_at) VALUES (?, 'Security user', ?, 'normal', ?, ?, ?) RETURNING id").bind(address, await hashPassword(password), now, now, now).first<{ id: number }>())!.id;
}
async function reauth() { expect((await call('/api/v1/me/security/reauth', { password })).status).toBe(200); }
async function enableTotp() {
  await reauth();
  const begin = await call('/api/v1/me/security/totp/begin', {});
  expect(begin.status).toBe(200);
  const { secret } = await begin.json<{ secret: string }>();
  const challengeCookie = cookies(begin);
  const code = await totp(secret, Math.floor(Date.now() / 30000));
  const confirm = await call('/api/v1/me/security/totp/confirm', { code }, cookie + '; ' + challengeCookie);
  expect(confirm.status).toBe(200);
  const codes = await confirm.json<{ recoveryCodes: string[] }>();
  return { secret, codes: codes.recoveryCodes };
}
async function login() { return call('/api/v1/auth/login', { identifier: email, password, destination: '/connect/device', keep: true }, ''); }
async function protectWithEmail(userId: number) {
  await state(bindings(), userId);
  await env.DB.prepare('UPDATE account_security SET email_enabled = 1 WHERE user_id = ?').bind(userId).run();
  const code = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('INSERT INTO recovery_codes (id, user_id) VALUES (?, ?)').bind(await hashToken(`${userId}:${code}`), userId).run();
  return code;
}
function mockEmail(captured: string[]) {
  fetchMock.activate(); fetchMock.disableNetConnect();
  fetchMock.get('https://api.resend.com').intercept({ method: 'POST', path: '/emails' }).reply(200, (request: { body?: unknown }) => {
    const body = JSON.parse(String(request.body)) as { text: string };
    captured.push(body.text.match(/\b\d{6}\b/)![0]); return JSON.stringify({ id: 'sent' });
  }).times(2);
}
beforeAll(runMigrations);
beforeEach(async () => {
  email = `security-${crypto.randomUUID()}@example.com`; uid = await user(email);
  const session = await createSession(bindings(), uid, {});
  cookie = `${sessionCookieName(bindings())}=${session.token}`;
});
afterEach(() => { fetchMock.deactivate(); });

describe('two-factor authentication', () => {
  it('validates the RFC 6238 SHA-1 vector and encrypts secrets with a user binding', async () => {
    const secret = base32(new TextEncoder().encode('12345678901234567890'));
    expect(await totp(secret, 1, 8)).toBe('94287082');
    for (const step of [99, 100, 101]) expect(await matchingStep(secret, await totp(secret, step), 3000000)).toBe(step);
    expect(await matchingStep(secret, await totp(secret, 102), 3000000)).toBeNull();
    const ciphertext = await encryptSecret(secret, key, uid);
    expect(await decryptSecret(ciphertext, key, uid)).toBe(secret);
    await expect(decryptSecret(ciphertext, key, uid + 1)).rejects.toThrow();
    await expect(encryptSecret(secret, undefined, uid)).rejects.toThrow();
  });
  it('requires reauthentication for enrollment and creates ten hashed recovery codes', async () => {
    expect((await call('/api/v1/me/security/totp/begin', {})).status).toBe(403);
    const result = await enableTotp();
    expect(result.codes).toHaveLength(10);
    const config = await state(bindings(), uid);
    expect(config.totp_secret).not.toContain(result.secret);
    const stored = (await env.DB.prepare('SELECT id FROM recovery_codes WHERE user_id = ?').bind(uid).all<{ id: string }>()).results;
    expect(stored).toHaveLength(10); expect(stored.map(r => r.id)).not.toContain(result.codes[0]);
    expect((await call('/api/v1/me/security', undefined)).status).toBe(200);
  });
  it('withholds sessions until second-factor verification, binds the browser, and rejects TOTP replay', async () => {
    const result = await enableTotp();
    const start = await login(); expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ requiresTwoFactor: true });
    const pending = cookies(start); expect(pending).not.toContain('bs_session');
    expect((await call('/api/v1/auth/session', undefined, pending)).status).toBe(401);
    expect((await call('/api/v1/auth/2fa', undefined, pending.split('; ')[0]!)).status).toBe(401);
    expect((await call('/api/v1/auth/2fa/verify', { method: 'totp', code: await totp(result.secret, Math.floor(Date.now() / 30000)) }, pending)).status).toBe(401);
    const nextCode = await totp(result.secret, Math.floor(Date.now() / 30000) + 1);
    const verified = await call('/api/v1/auth/2fa/verify', { method: 'totp', code: nextCode }, pending);
    expect(verified.status).toBe(200); expect(await verified.json()).toMatchObject({ id: uid, redirect: '/connect/device' });
    expect((await call('/api/v1/auth/session', undefined, cookies(verified))).status).toBe(200);
    expect((await call('/api/v1/auth/2fa/verify', { method: 'totp', code: nextCode }, pending)).status).toBe(401);
  });
  it('atomically consumes recovery codes and rejects concurrent challenge replay', async () => {
    const { codes } = await enableTotp(); const start = await login(), pending = cookies(start);
    const results = await Promise.all([1, 2].map(() => call('/api/v1/auth/2fa/verify', { method: 'recovery', code: codes[0] }, pending)));
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    expect(await env.DB.prepare('SELECT id FROM recovery_codes WHERE id = ?').bind(await hashToken(`${uid}:${codes[0]}`)).first()).toBeNull();
  });
  it('locks a challenge after five failures, expires challenges, and limits renewed challenges', async () => {
    await enableTotp(); let start = await login(), pending = cookies(start);
    for (let i = 0; i < 5; i++) expect((await call('/api/v1/auth/2fa/verify', { method: 'recovery', code: 'bad-code' }, pending)).status).toBe(401);
    expect((await call('/api/v1/auth/2fa', undefined, pending)).status).toBe(401);
    start = await login(); pending = cookies(start);
    await env.DB.prepare('UPDATE security_challenges SET expires_at = 1 WHERE user_id = ?').bind(uid).run();
    expect((await call('/api/v1/auth/2fa', undefined, pending)).status).toBe(401);
    for (let i = 0; i < 30; i++) await env.DB.prepare("INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at) VALUES ('other-ip', ?, 'security', 0, ?)").bind(String(uid), Date.now()).run();
    expect((await login()).status).toBe(429);
  });
  it('fails closed without an encryption key and invalidates challenges on password reset or bans', async () => {
    const { codes } = await enableTotp(); const start = await login(), pending = cookies(start);
    expect((await call('/api/v1/auth/2fa/verify', { method: 'totp', code: '123456' }, pending, 'POST', { MFA_ENCRYPTION_KEY: '' })).status).toBe(503);
    const raw = await mintRawToken(uid);
    expect((await call('/api/v1/auth/reset-password', { token: raw, password: 'new-password-9' }, '')).status).toBe(200);
    expect((await state(bindings(), uid)).totp_secret).not.toBeNull();
    expect((await call('/api/v1/auth/2fa/verify', { method: 'recovery', code: codes[0] }, pending)).status).toBe(401);
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), uid).run();
    const another = await login(); await env.DB.prepare("UPDATE users SET role = 'banned' WHERE id = ?").bind(uid).run();
    expect((await call('/api/v1/auth/2fa', undefined, cookies(another))).status).toBe(401);
  });
  it('regenerates recovery codes, revokes other sessions, and forbids removing the last method', async () => {
    const { codes } = await enableTotp();
    const other = await createSession(bindings(), uid, {});
    expect((await call('/api/v1/me/security/methods/totp', undefined, cookie, 'DELETE')).status).toBe(409);
    const regenerated = await call('/api/v1/me/security/recovery', {}); expect(regenerated.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM recovery_codes WHERE id = ?').bind(await hashToken(`${uid}:${codes[0]}`)).first()).toBeNull();
    expect((await call('/api/v1/auth/session', undefined, `bs_session=${other.token}`)).status).toBe(401);
    expect((await call('/api/v1/me/security/disable', {})).status).toBe(200);
    expect(await call('/api/v1/me/security').then(r => r.json())).toMatchObject({ enabled: false, recoveryRemaining: 0 });
  });
  it('enrolls email, throttles resends, and keeps the old email until the new address is verified', async () => {
    const sent: string[] = []; mockEmail(sent); await reauth();
    const begin = await call('/api/v1/me/security/email/begin', {}); expect(begin.status).toBe(200);
    let pending = cookie + '; ' + cookies(begin);
    expect((await call('/api/v1/me/security/email/email', {}, pending)).status).toBe(429);
    expect((await call('/api/v1/me/security/email/confirm', { code: sent[0] }, pending)).status).toBe(200);
    expect((await call('/api/v1/me', { email: 'unsafe@example.com' }, cookie, 'PATCH')).status).toBe(403);
    const changed = await call('/api/v1/me/security/change-email/begin', { email: 'new-security@example.com' }); expect(changed.status).toBe(200);
    pending = cookie + '; ' + cookies(changed);
    expect((await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(uid).first<{ email: string }>())!.email).toBe(email);
    expect((await call('/api/v1/me/security/change-email/confirm', { code: sent[1] }, pending)).status).toBe(200);
    expect((await env.DB.prepare('SELECT email, email_verified_at FROM users WHERE id = ?').bind(uid).first())!.email).toBe('new-security@example.com');
  });
  it('does not enable email when the mail provider fails', async () => {
    await reauth(); fetchMock.activate(); fetchMock.disableNetConnect();
    fetchMock.get('https://api.resend.com').intercept({ method: 'POST', path: '/emails' }).reply(503, 'Unavailable');
    expect((await call('/api/v1/me/security/email/begin', {})).status).toBe(503);
    expect((await state(bindings(), uid)).email_enabled).toBe(0);
  });
  it('deletes security state when an account is deleted', async () => {
    await enableTotp(); await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
    for (const table of ['account_security', 'recovery_codes', 'security_challenges', 'security_reauth']) expect(await env.DB.prepare(`SELECT user_id FROM ${table} WHERE user_id = ?`).bind(uid).first()).toBeNull();
  });
  it('invalidates old email codes on resend and rejects expired email codes', async () => {
    await protectWithEmail(uid); const sent: string[] = []; mockEmail(sent);
    const start = await login(), pending = cookies(start);
    expect((await call('/api/v1/auth/2fa/email', {}, pending)).status).toBe(200);
    await env.DB.prepare('UPDATE security_challenges SET mail_sent_at = ? WHERE user_id = ?').bind(Date.now() - 61000, uid).run();
    expect((await call('/api/v1/auth/2fa/email', {}, pending)).status).toBe(200);
    const oldHash = await hashToken(`${(await env.DB.prepare('SELECT id FROM security_challenges WHERE user_id = ?').bind(uid).first<{ id: string }>())!.id}:${sent[0]}`);
    expect((await env.DB.prepare('SELECT email_hash FROM security_challenges WHERE user_id = ?').bind(uid).first<{ email_hash: string }>())!.email_hash).not.toBe(oldHash);
    expect((await call('/api/v1/auth/2fa/verify', { method: 'email', code: sent[0] }, pending)).status).toBe(401);
    await env.DB.prepare('UPDATE security_challenges SET email_expires_at = 1 WHERE user_id = ?').bind(uid).run();
    expect((await call('/api/v1/auth/2fa/verify', { method: 'email', code: sent[1] }, pending)).status).toBe(401);
  });
  it('requires the existing second factor for security reauthentication and expires grants', async () => {
    const { codes } = await enableTotp();
    await env.DB.prepare('UPDATE security_reauth SET expires_at = 1 WHERE user_id = ?').bind(uid).run();
    expect((await call('/api/v1/me/security/recovery', {})).status).toBe(403);
    const begin = await call('/api/v1/me/security/reauth', { password });
    expect(await begin.json()).toMatchObject({ requiresTwoFactor: true });
    const pending = cookie + '; ' + cookies(begin);
    expect((await call('/api/v1/auth/2fa/verify', { method: 'recovery', code: codes[0] }, pending)).status).toBe(200);
    expect((await call('/api/v1/me/security/recovery', {})).status).toBe(200);
  });
  it('keeps legacy launcher password authentication available', async () => {
    await protectWithEmail(uid);
    await env.DB.prepare("INSERT INTO players (user_id, name, created_at, updated_at) VALUES (?, 'SecurityPlayer', ?, ?)").bind(uid, Date.now(), Date.now()).run();
    const authenticated = await call('/api/yggdrasil/authserver/authenticate', { username: email, password, clientToken: 'security-launcher' }, '');
    expect(authenticated.status).toBe(200); expect(await authenticated.json()).toHaveProperty('accessToken');
  });
  it('waits for every protected legacy account before merging and keeps the retained security state', async () => {
    await env.DB.prepare('UPDATE users SET legacy_email_conflict = 1 WHERE id = ?').bind(uid).run();
    const now = Date.now();
    const secondId = (await env.DB.prepare("INSERT INTO users (email, nickname, password_hash, role, email_verified_at, created_at, updated_at, legacy_email_conflict) VALUES (?, 'Second', ?, 'normal', ?, ?, ?, 1) RETURNING id").bind(email, await hashPassword(password), now, now, now).first<{ id: number }>())!.id;
    const firstCode = await protectWithEmail(uid), secondCode = await protectWithEmail(secondId);
    const start = await call('/api/v1/auth/login', { identifier: email, password, retainUserId: uid }, '');
    expect(await start.json()).toMatchObject({ requiresTwoFactor: true });
    const pending = cookies(start);
    const first = await call('/api/v1/auth/2fa/verify', { method: 'recovery', code: firstCode }, pending);
    expect(first.status).toBe(200); expect(await first.json()).toMatchObject({ requiresTwoFactor: true });
    expect((await env.DB.prepare('SELECT merged_into_user_id FROM users WHERE id = ?').bind(secondId).first())!.merged_into_user_id).toBeNull();
    const second = await call('/api/v1/auth/2fa/verify', { method: 'recovery', code: secondCode }, cookies(first));
    expect(second.status).toBe(200); expect(await second.json()).toMatchObject({ id: uid });
    expect((await env.DB.prepare('SELECT merged_into_user_id FROM users WHERE id = ?').bind(secondId).first())!.merged_into_user_id).toBe(uid);
    expect((await state(bindings(), uid)).email_enabled).toBe(1);
    expect(await env.DB.prepare('SELECT user_id FROM account_security WHERE user_id = ?').bind(secondId).first()).toBeNull();
  });
});

async function githubCallback(session = '', target = '/user') {
  const start = await call(`/auth/oauth/github?redirect=${encodeURIComponent(target)}`, undefined, session);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  fetchMock.activate(); fetchMock.disableNetConnect();
  fetchMock.get('https://github.com').intercept({ method: 'POST', path: '/login/oauth/access_token' }).reply(200, JSON.stringify({ access_token: 'test-token' }));
  fetchMock.get('https://api.github.com').intercept({ path: '/user' }).reply(200, JSON.stringify({ id: 'security-github', name: 'Security user' }));
  fetchMock.get('https://api.github.com').intercept({ path: '/user/emails' }).reply(200, JSON.stringify([{ email, verified: true, primary: true }]));
  return call(`/auth/oauth/github/callback?state=${state}&code=test-code`, undefined, [session, cookies(start)].filter(Boolean).join('; '));
}
describe('third-party identity verification', () => {
  beforeEach(async () => { await env.DB.prepare("INSERT INTO user_identities (provider, provider_user_id, user_id, created_at) VALUES ('github', 'security-github', ?, ?)").bind(uid, Date.now()).run(); });
  it('does not issue a session from an OAuth callback before second-factor verification', async () => {
    const code = await protectWithEmail(uid), response = await githubCallback();
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/auth/two-factor');
    const pending = cookies(response); expect(pending).not.toContain('bs_session');
    expect((await call('/api/v1/auth/session', undefined, pending)).status).toBe(401);
    expect((await call('/api/v1/auth/2fa/verify', { method: 'recovery', code }, pending)).status).toBe(200);
  });
  it('reauthenticates a passwordless account only with its already bound provider identity', async () => {
    await env.DB.prepare("UPDATE users SET password_hash = '' WHERE id = ?").bind(uid).run();
    expect((await call('/api/v1/me/security/totp/begin', {})).status).toBe(403);
    const response = await githubCallback(cookie, '/profile?security_reauth=1');
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/profile?security_reauth=1');
    expect((await call('/api/v1/me/security/totp/begin', {})).status).toBe(200);
  });
});

function concat(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((n, b) => n + b.length, 0)); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
}
async function virtualAuthenticator() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  const id = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 3], [3, -257], [-1, new Uint8Array(base64url.decode(jwk.n!))], [-2, new Uint8Array(base64url.decode(jwk.e!))]]));
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('x')));
  const clientData = (challenge: string, type: string, origin = 'https://x') => new TextEncoder().encode(JSON.stringify({ challenge, type, origin, crossOrigin: false }));
  return {
    id: base64url.encode(id), userHandle: '',
    register(options: PublicKeyCredentialCreationOptionsJSON, origin = 'https://x', flags = 0x45) {
      this.userHandle = options.user.id;
      const length = new Uint8Array(2); new DataView(length.buffer).setUint16(0, id.length);
      const data = concat(rpHash, new Uint8Array([flags]), new Uint8Array(4), new Uint8Array(16), length, id, publicKey);
      const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, never>>([['fmt', 'none'], ['authData', data], ['attStmt', new Map<string, never>()]]));
      return { id: this.id, rawId: this.id, type: 'public-key' as const, response: { clientDataJSON: base64url.encode(clientData(options.challenge, 'webauthn.create', origin)), attestationObject: base64url.encode(attestation), transports: ['internal' as const] }, clientExtensionResults: {} };
    },
    async authenticate(options: PublicKeyCredentialRequestOptionsJSON, counter = 1, origin = 'https://x', flags = 0x05, rpID = 'x'): Promise<AuthenticationResponseJSON> {
      const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, counter);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpID)));
      const data = concat(hash, new Uint8Array([flags]), count), client = clientData(options.challenge, 'webauthn.get', origin);
      const signed = concat(data, new Uint8Array(await crypto.subtle.digest('SHA-256', client)));
      const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, signed));
      return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: base64url.encode(client), authenticatorData: base64url.encode(data), signature: base64url.encode(signature), userHandle: this.userHandle } };
    },
  };
}
async function registerKey(authenticator: Awaited<ReturnType<typeof virtualAuthenticator>>) {
  const begin = await call('/api/v1/me/security/passkeys/options', {}); expect(begin.status).toBe(200);
  const response = authenticator.register(await begin.json<PublicKeyCredentialCreationOptionsJSON>());
  const confirmed = await call('/api/v1/me/security/passkeys/verify', { name: 'Test key', response }, cookie + '; ' + cookies(begin)); expect(confirmed.status).toBe(200);
}
describe('WebAuthn on workerd', () => {
  it('registers discoverable keys and performs passwordless login with actual signatures', async () => {
    await reauth(); const authenticator = await virtualAuthenticator(); await registerKey(authenticator);
    const begin = await call('/api/v1/auth/passkeys/options', { remember: true, destination: '/user' }, ''); expect(begin.status).toBe(200);
    const verified = await call('/api/v1/auth/passkeys/verify', await authenticator.authenticate(await begin.json<PublicKeyCredentialRequestOptionsJSON>()), cookies(begin)); expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ id: uid, redirect: '/user' });
    expect((await call('/api/v1/auth/session', undefined, cookies(verified))).status).toBe(200);
  });
  it('rejects registration without user verification, wrong origins, and HTTP', async () => {
    await reauth(); const authenticator = await virtualAuthenticator();
    const begin = await call('/api/v1/me/security/passkeys/options', {}), options = await begin.json<PublicKeyCredentialCreationOptionsJSON>();
    const pending = cookie + '; ' + cookies(begin);
    for (const response of [authenticator.register(options, 'https://evil.example'), authenticator.register(options, 'https://x', 0x41)]) expect((await call('/api/v1/me/security/passkeys/verify', { name: 'Invalid', response }, pending)).status).toBe(401);
    expect((await call('/api/v1/auth/passkeys/options', {}, '', 'POST', { APP_URL: 'http://x' }, 'http://x')).status).toBe(403);
  });
  it('rejects invalid signatures, origins, missing user verification and counter replay', async () => {
    await reauth(); const authenticator = await virtualAuthenticator(); await registerKey(authenticator);
    const begin = await call('/api/v1/auth/passkeys/options', {}, ''), options = await begin.json<PublicKeyCredentialRequestOptionsJSON>(), pending = cookies(begin);
    const invalid = await authenticator.authenticate(options); invalid.response.signature = base64url.encode(new Uint8Array(256));
    for (const response of [invalid, await authenticator.authenticate(options, 1, 'https://evil.example'), await authenticator.authenticate(options, 1, 'https://x', 0x01), await authenticator.authenticate(options, 1, 'https://x', 0x05, 'evil.example')]) expect((await call('/api/v1/auth/passkeys/verify', response, pending)).status).toBe(401);
    const valid = await authenticator.authenticate(options); expect((await call('/api/v1/auth/passkeys/verify', valid, pending)).status).toBe(200);
    const second = await call('/api/v1/auth/passkeys/options', {}, '');
    expect((await call('/api/v1/auth/passkeys/verify', await authenticator.authenticate(await second.json<PublicKeyCredentialRequestOptionsJSON>(), 1), cookies(second))).status).toBe(401);
  });
  it('uses a browser key as a second factor and rejects another account key', async () => {
    await reauth(); const authenticator = await virtualAuthenticator(); await registerKey(authenticator);
    const start = await login(), pending = cookies(start);
    const options = await call('/api/v1/auth/2fa/passkey/options', {}, pending); expect(options.status).toBe(200);
    const response = await authenticator.authenticate(await options.json<PublicKeyCredentialRequestOptionsJSON>());
    await env.DB.prepare('UPDATE passkeys SET user_id = ? WHERE id = ?').bind(await user('another-key@example.com'), authenticator.id).run();
    expect((await call('/api/v1/auth/2fa/verify', { method: 'passkey', response }, pending)).status).toBe(401);
    await env.DB.prepare('UPDATE passkeys SET user_id = ? WHERE id = ?').bind(uid, authenticator.id).run();
    expect((await call('/api/v1/auth/2fa/verify', { method: 'passkey', response }, pending)).status).toBe(200);
  });
  it('rejects duplicate registration and supports authenticators with a zero counter', async () => {
    await reauth(); const authenticator = await virtualAuthenticator(); await registerKey(authenticator);
    const begin = await call('/api/v1/me/security/passkeys/options', {});
    const duplicate = authenticator.register(await begin.json<PublicKeyCredentialCreationOptionsJSON>());
    expect((await call('/api/v1/me/security/passkeys/verify', { name: 'Duplicate', response: duplicate }, cookie + '; ' + cookies(begin))).status).toBe(409);
    for (let i = 0; i < 2; i++) {
      const start = await call('/api/v1/auth/passkeys/options', {}, '');
      expect((await call('/api/v1/auth/passkeys/verify', await authenticator.authenticate(await start.json<PublicKeyCredentialRequestOptionsJSON>(), 0), cookies(start))).status).toBe(200);
    }
  });
});
