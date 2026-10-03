import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { base64url } from 'jose';
import { hashToken, mintTokenWithHash, verifyStoredPassword } from '@pigeon-skin/auth';
import { LIMITS } from '@pigeon-skin/shared';
import type { SecondFactor, SecurityChallenge, SecurityStatus } from '@pigeon-skin/shared/security';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON, type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { AppError, currentUser, fail } from '../framework.ts';
import { clientIp, setSessionCookie, needsAccountInitialization, getSetting, type AppEnv } from '../lib.ts';
import type { Bindings } from '../env.ts';
import * as repo from '../repositories/security.ts';
import { decryptSecret, encryptSecret, randomToken, base32, matchingStep, emailCode } from './security-crypto.ts';
import { isEmailConfigured, sendEmail } from './email.ts';
import { checkEmailDomain } from './email-policy.ts';
import { mergeLegacyAccounts } from './account-merge.ts';

type Ctx = Context<AppEnv>;
type Payload = {
  remember?: boolean; destination?: string; challenge?: string; secret?: string;
  email?: string; loginSource?: string;
  merge?: { retainedId: number; ids: number[]; snapshots: Array<{ id: number; hash: string; version: number }>; verifiedIds: number[] };
};
const COOKIE = 'security_challenge';
const BROWSER = 'security_browser';
const CHALLENGE_MS = 600000;
export const destination = (value: string | undefined) => value && /^\/(?!\/)[A-Za-z0-9/_?=&%+.,~-]*$/.test(value) ? value : '/user';
function noStore(c: Ctx) { c.header('Cache-Control', 'no-store'); }
function cookieOptions(c: Ctx) { return { path: '/', httpOnly: true, sameSite: 'Lax' as const, secure: new URL(c.req.url).protocol === 'https:', maxAge: 600 }; }
export async function credentialsHash(env: Pick<Bindings, 'DB'>, userId: number) {
  const user = await repo.user(env, userId);
  if (!user || user.role === 'banned' || user.merged_into_user_id !== null) throw fail.forbidden('auth.account_banned');
  return hashToken(`${user.password_hash}\n${user.email}\n${user.role}`);
}
export async function throttle(c: Ctx, userId: number | null, kind = 'security') {
  const ip = clientIp(c);
  const identifier = String(userId ?? 'anonymous');
  const now = Date.now();
  const row = await c.env.DB.prepare(`INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at) SELECT ?, ?, ?, 0, ? WHERE (SELECT COUNT(*) FROM auth_attempts WHERE kind = ? AND created_at > ? AND (ip = ? OR (? IS NOT NULL AND identifier = ?))) < 30 RETURNING id`).bind(ip, identifier, kind, now, kind, now - 900000, ip, userId, identifier).first();
  if (!row) throw new AppError('common.rate_limited', 429);
}
export async function newChallenge(c: Ctx, userId: number | null, purpose: string, payload: Payload = {}) {
  noStore(c);
  await throttle(c, userId);
  const token = randomToken(), browser = randomToken(), now = Date.now();
  const old = getCookie(c, COOKIE);
  if (old) await c.env.DB.prepare('DELETE FROM security_challenges WHERE id = ?').bind(await hashToken(old)).run();
  const config = userId === null ? null : await repo.state(c.env, userId);
  await c.env.DB.prepare('INSERT INTO security_challenges (id, browser_hash, user_id, session_id, purpose, version, credentials_hash, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await hashToken(token), await hashToken(browser), userId, purpose === 'login' || purpose === 'passkey-login' ? null : c.get('sessionId'), purpose, config?.version ?? null, userId === null ? null : await credentialsHash(c.env, userId), JSON.stringify(payload), now, now + CHALLENGE_MS).run();
  setCookie(c, COOKIE, token, cookieOptions(c)); setCookie(c, BROWSER, browser, cookieOptions(c));
  return (await c.env.DB.prepare('SELECT * FROM security_challenges WHERE id = ?').bind(await hashToken(token)).first<repo.ChallengeRow>())!;
}
export async function challenge(c: Ctx, purposes: string[]) {
  noStore(c);
  const raw = getCookie(c, COOKIE), browser = getCookie(c, BROWSER);
  if (!raw || !browser) throw new AppError('security.challenge_expired', 401);
  const row = await c.env.DB.prepare('SELECT * FROM security_challenges WHERE id = ? AND browser_hash = ? AND expires_at > ? AND attempts < 5 AND claim IS NULL')
    .bind(await hashToken(raw), await hashToken(browser), Date.now()).first<repo.ChallengeRow>();
  if (!row || !purposes.includes(row.purpose)) throw new AppError('security.challenge_expired', 401);
  if (row.session_id && (row.session_id !== c.get('sessionId') || row.user_id !== c.get('user')?.id)) throw fail.unauthorized();
  if (row.user_id !== null) {
    const state = await repo.state(c.env, row.user_id);
    if (state.version !== row.version || await credentialsHash(c.env, row.user_id) !== row.credentials_hash) throw new AppError('security.challenge_expired', 401);
  }
  return row;
}
export function clearChallenge(c: Ctx) {
  deleteCookie(c, COOKIE, { path: '/' }); deleteCookie(c, BROWSER, { path: '/' });
}
export async function challengeInfo(c: Ctx): Promise<SecurityChallenge> {
  const row = await challenge(c, ['login', 'reauth']);
  const user = (await repo.user(c.env, row.user_id!))!;
  const methods = await repo.methods(c.env, user.id);
  return { methods, expiresAt: row.expires_at, email: methods.includes('email') ? user.email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2') : null, account: user.nickname, purpose: row.purpose as 'login' | 'reauth' };
}
export function relyingParty(c: Ctx) {
  const url = new URL(c.env.APP_URL), request = new URL(c.req.url);
  if (url.protocol !== 'https:' || request.protocol !== 'https:') throw new AppError('security.https_required', 403);
  if (request.origin !== url.origin) throw fail.forbidden();
  return { rpID: url.hostname, origin: url.origin };
}
export async function status(c: Ctx): Promise<SecurityStatus> {
  noStore(c);
  const user = currentUser(c), config = await repo.state(c.env, user.id);
  const passkeys = await repo.keys(c.env, user.id);
  const recovery = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?').bind(user.id).first<{ n: number }>();
  const grant = await c.env.DB.prepare('SELECT session_id FROM security_reauth WHERE session_id = ? AND user_id = ? AND version = ? AND expires_at > ? AND claim IS NULL').bind(c.get('sessionId'), user.id, config.version, Date.now()).first();
  const credentials = (await repo.user(c.env, user.id))!;
  let passkeysAvailable: boolean;
  try { relyingParty(c); passkeysAvailable = true; } catch { passkeysAvailable = false; }
  return { enabled: !!(config.email_enabled || config.totp_secret || passkeys.length), email: !!config.email_enabled, totp: !!config.totp_secret,
    passkeys: passkeys.map(k => ({ id: k.id, name: k.name, createdAt: k.created_at })), recoveryRemaining: recovery?.n ?? 0,
    emailAvailable: isEmailConfigured(c.env) && credentials.email_verified_at !== null && !credentials.email.endsWith('@oauth.invalid'),
    mailAvailable: isEmailConfigured(c.env),
    totpAvailable: !!c.env.MFA_ENCRYPTION_KEY, passkeysAvailable, reauthenticated: !!grant, hasPassword: !!credentials.password_hash };
}
export async function grantReauth(c: Ctx, userId: number, expected: { version: number; credentialsHash: string; challengeId?: string; claim?: string }) {
  if (!c.get('sessionId') || c.get('user')?.id !== userId) throw fail.unauthorized();
  const config = await repo.state(c.env, userId);
  const credentials = (await repo.user(c.env, userId))!;
  if (config.version !== expected.version || await credentialsHash(c.env, userId) !== expected.credentialsHash) throw new AppError('security.challenge_expired', 401);
  const now = Date.now();
  const proofGuard = expected.challengeId ? ' AND EXISTS (SELECT 1 FROM security_challenges WHERE id = ? AND user_id = ? AND claim = ? AND version = ? AND expires_at > ?)' : '';
  const proofValues = expected.challengeId ? [expected.challengeId, userId, expected.claim!, config.version, now] : [];
  const grant = await c.env.DB.prepare("INSERT INTO security_reauth (session_id, user_id, version, expires_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions JOIN users ON users.id = sessions.user_id JOIN account_security ON account_security.user_id = users.id WHERE sessions.id = ? AND sessions.user_id = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ? AND sessions.absolute_expires_at > ? AND users.role != 'banned' AND account_security.version = ? AND users.password_hash = ? AND users.email = ? AND users.role = ?)" + proofGuard + ' ON CONFLICT(session_id) DO UPDATE SET version = excluded.version, expires_at = excluded.expires_at, claim = NULL RETURNING session_id')
    .bind(c.get('sessionId'), userId, config.version, now + 300000, c.get('sessionId'), userId, now, now, config.version, credentials.password_hash, credentials.email, credentials.role, ...proofValues).first();
  if (!grant) throw fail.unauthorized();
}
export async function assertReauth(c: Ctx) {
  const user = currentUser(c);
  if (!(await status(c)).reauthenticated) throw new AppError('security.reauth_required', 403);
  return user;
}
export async function passwordReauth(c: Ctx, password: string) {
  const user = currentUser(c);
  await throttle(c, user.id);
  const config = await repo.state(c.env, user.id);
  if ((await repo.methods(c.env, user.id)).length) return newChallenge(c, user.id, 'reauth');
  const credentials = (await repo.user(c.env, user.id))!;
  if (!credentials.password_hash || !await verifyStoredPassword(password, credentials.password_hash, { legacySalt: c.env.LEGACY_SALT ?? '' })) throw new AppError('auth.invalid_credentials', 401);
  await grantReauth(c, user.id, { version: config.version, credentialsHash: await hashToken(`${credentials.password_hash}\n${credentials.email}\n${credentials.role}`) });
  return null;
}
export async function sendChallengeEmail(c: Ctx, created?: repo.ChallengeRow) {
  const row = created ?? await challenge(c, ['login', 'reauth', 'email-enroll', 'change-email']);
  const user = (await repo.user(c.env, row.user_id!))!;
  if (['login', 'reauth'].includes(row.purpose) && !(await repo.state(c.env, user.id)).email_enabled) throw fail.forbidden();
  if (!isEmailConfigured(c.env)) throw new AppError('auth.mail_unavailable', 503);
  await throttle(c, user.id, 'security-mail');
  const now = Date.now(), code = emailCode(), payload = JSON.parse(row.payload) as Payload;
  const previous = row.mail_sent_at;
  const updated = await c.env.DB.prepare('UPDATE security_challenges SET email_hash = ?, email_expires_at = ?, mail_sent_at = ? WHERE id = ? AND claim IS NULL AND attempts < 5 AND expires_at > ? AND (mail_sent_at IS NULL OR mail_sent_at <= ?) RETURNING id')
    .bind(await hashToken(`${row.id}:${code}`), now + 300000, now, row.id, now, now - 60000).first();
  if (!updated) throw new AppError('common.rate_limited', 429);
  let ok: boolean;
  try { ok = (await sendEmail(c.env, { kind: 'security-code', to: payload.email ?? user.email, code, locale: c.get('user')?.locale ?? c.req.header('x-locale') ?? null })).ok; } catch { ok = false; }
  if (!ok) {
    await c.env.DB.prepare('UPDATE security_challenges SET email_hash = NULL, email_expires_at = NULL, mail_sent_at = ? WHERE id = ? AND mail_sent_at = ?').bind(previous, row.id, now).run();
    throw new AppError('auth.mail_unavailable', 503);
  }
}
async function attempt(c: Ctx, row: repo.ChallengeRow) {
  await throttle(c, row.user_id);
  const result = await c.env.DB.prepare('UPDATE security_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < 5 AND claim IS NULL AND expires_at > ? RETURNING id').bind(row.id, Date.now()).first();
  if (!result) throw new AppError('security.challenge_expired', 401);
}
export async function consumeProof(c: Ctx, row: repo.ChallengeRow, method: SecondFactor, code = '', response?: AuthenticationResponseJSON) {
  await attempt(c, row);
  const userId = row.user_id!, config = await repo.state(c.env, userId), now = Date.now();
  let condition = '1 = 0';
  let params: (number | string)[] = [];
  let consume: { sql: string; params: (number | string)[] } | null = null;
  if (method === 'email' && row.email_hash && row.email_expires_at! > now && await hashToken(`${row.id}:${code}`) === row.email_hash && (config.email_enabled || ['email-enroll', 'change-email'].includes(row.purpose))) {
    condition = 'email_hash = ? AND email_expires_at > ?'; params = [row.email_hash, now];
  } else if (method === 'totp' && (config.totp_secret || row.purpose === 'totp-enroll')) {
    const encrypted = row.purpose === 'totp-enroll' ? (JSON.parse(row.payload) as Payload).secret! : config.totp_secret!;
    const step = await matchingStep(await decryptSecret(encrypted, c.env.MFA_ENCRYPTION_KEY, userId), code);
    if (step !== null) {
      condition = 'EXISTS (SELECT 1 FROM account_security WHERE user_id = ? AND version = ? AND totp_last_step < ?)'; params = [userId, config.version, step];
      consume = { sql: 'UPDATE account_security SET totp_last_step = ? WHERE user_id = ?', params: [step, userId] };
    }
  } else if (method === 'recovery' && ['login', 'reauth'].includes(row.purpose)) {
    const id = await hashToken(`${userId}:${code.replace(/[\s-]/g, '').toLowerCase()}`);
    condition = 'EXISTS (SELECT 1 FROM recovery_codes WHERE id = ? AND user_id = ?)'; params = [id, userId];
    consume = { sql: 'DELETE FROM recovery_codes WHERE id = ? AND user_id = ?', params: [id, userId] };
  } else if (method === 'passkey' && response) {
    const key = await repo.credential(c.env, response.id);
    if (key && key.user_id === userId) {
      const expected = (JSON.parse(row.payload) as Payload).challenge;
      if (expected) {
        try {
          const rp = relyingParty(c);
          const verified = await verifyAuthenticationResponse({ response, expectedChallenge: expected, expectedOrigin: rp.origin, expectedRPID: rp.rpID,
            credential: { id: key.id, publicKey: new Uint8Array(base64url.decode(key.public_key)), counter: key.counter, transports: JSON.parse(key.transports) as AuthenticatorTransportFuture[] }, requireUserVerification: true });
          if (verified.verified) {
            condition = 'EXISTS (SELECT 1 FROM passkeys WHERE id = ? AND user_id = ? AND counter = ?)'; params = [key.id, userId, key.counter];
            consume = { sql: 'UPDATE passkeys SET counter = ?, backed_up = ? WHERE id = ?', params: [verified.authenticationInfo.newCounter, Number(verified.authenticationInfo.credentialBackedUp), key.id] };
          }
        } catch (error) { if (error instanceof AppError) throw error; }
      }
    }
  }
  const claim = randomToken();
  const guard = `EXISTS (SELECT 1 FROM security_challenges WHERE id = '${row.id}' AND claim = '${claim}')`;
  const statements = [c.env.DB.prepare(`UPDATE security_challenges SET claim = ? WHERE id = ? AND user_id = ? AND claim IS NULL AND expires_at > ? AND version = ? AND credentials_hash = ? AND (${condition}) AND EXISTS (SELECT 1 FROM account_security WHERE user_id = ? AND version = ?) AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role != 'banned' AND merged_into_user_id IS NULL) RETURNING id`)
    .bind(claim, row.id, userId, now, config.version, await credentialsHash(c.env, userId), ...params, userId, config.version, userId)];
  if (consume) statements.push(c.env.DB.prepare(`${consume.sql} AND ${guard}`).bind(...consume.params));
  const result = await c.env.DB.batch(statements);
  if (!result[0]!.results.length) throw new AppError('security.invalid_code', 401);
  return claim;
}
export async function authenticationOptions(c: Ctx) {
  const row = await challenge(c, ['login', 'reauth']);
  const rp = relyingParty(c);
  const keys = await repo.keys(c.env, row.user_id!);
  if (!keys.length) throw fail.forbidden();
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', allowCredentials: keys.map(key => ({ id: key.id, transports: JSON.parse(key.transports) as AuthenticatorTransportFuture[] })) });
  const payload = JSON.parse(row.payload) as Payload; payload.challenge = options.challenge;
  await c.env.DB.prepare('UPDATE security_challenges SET payload = ? WHERE id = ? AND claim IS NULL').bind(JSON.stringify(payload), row.id).run();
  return options;
}
export async function beginLogin(c: Ctx, userId: number, payload: Payload): Promise<boolean> {
  if (!(await repo.methods(c.env, userId)).length) return false;
  await newChallenge(c, userId, 'login', payload);
  return true;
}
export async function finishLogin(c: Ctx, row: repo.ChallengeRow) {
  const payload = JSON.parse(row.payload) as Payload;
  const user = (await repo.user(c.env, row.user_id!))!;
  if (await credentialsHash(c.env, user.id) !== row.credentials_hash || (await repo.state(c.env, user.id)).version !== row.version) throw new AppError('security.challenge_expired', 401);
  const now = Date.now(), absoluteSeconds = payload.remember ? LIMITS.sessionRememberSeconds : LIMITS.sessionAbsoluteSeconds;
  const idleSeconds = payload.remember ? LIMITS.sessionRememberSeconds : LIMITS.sessionIdleSeconds;
  const { token, tokenHash } = await mintTokenWithHash();
  const statements = [c.env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, ip, user_agent) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM account_security WHERE user_id = ? AND version = ?) AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ? AND email = ? AND role = ? AND role != 'banned' AND merged_into_user_id IS NULL) RETURNING id")
    .bind(tokenHash, user.id, now, now, now + idleSeconds * 1000, now + absoluteSeconds * 1000, clientIp(c), c.req.header('user-agent') ?? null, user.id, row.version, user.id, user.password_hash, user.email, user.role)];
  statements.push(c.env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ?)').bind(now, user.id, tokenHash, tokenHash));
  statements.push(c.env.DB.prepare('DELETE FROM security_challenges WHERE id = ?').bind(row.id));
  const result = await c.env.DB.batch(statements);
  if (!result[0]!.results.length) throw new AppError('security.challenge_expired', 401);
  setSessionCookie(c, token, absoluteSeconds);
  clearChallenge(c);
  const target = destination(payload.destination);
  return { id: user.id, redirect: needsAccountInitialization(user.email, user.password_hash, !!user.needs_initialization) ? `/auth/initialize?redirect=${encodeURIComponent(target)}` : target };
}
export async function verifyChallenge(c: Ctx, method: SecondFactor, code: string, response?: AuthenticationResponseJSON) {
  const row = await challenge(c, ['login', 'reauth']);
  const proofClaim = await consumeProof(c, row, method, code, response);
  if (row.purpose === 'reauth') {
    await grantReauth(c, row.user_id!, { version: row.version!, credentialsHash: row.credentials_hash!, challengeId: row.id, claim: proofClaim });
    await c.env.DB.prepare('DELETE FROM security_challenges WHERE id = ?').bind(row.id).run(); clearChallenge(c);
    return { ok: true, redirect: '/profile' };
  }
  const payload = JSON.parse(row.payload) as Payload;
  if (payload.merge) {
    const merge = payload.merge;
    merge.verifiedIds.push(row.user_id!);
    for (const snapshot of merge.snapshots) {
      if (await credentialsHash(c.env, snapshot.id) !== snapshot.hash || (await repo.state(c.env, snapshot.id)).version !== snapshot.version) throw new AppError('security.challenge_expired', 401);
    }
    const pending = merge.ids.find(id => !merge.verifiedIds.includes(id));
    if (pending !== undefined) {
      await newChallenge(c, pending, 'login', payload);
      return { requiresTwoFactor: true as const, methods: await repo.methods(c.env, pending) };
    }
    const retained = (await repo.user(c.env, merge.retainedId))!;
    const expected = [];
    for (const snapshot of merge.snapshots) {
      const account = (await repo.user(c.env, snapshot.id))!;
      if (await credentialsHash(c.env, snapshot.id) !== snapshot.hash) throw new AppError('security.challenge_expired', 401);
      expected.push({ id: account.id, passwordHash: account.password_hash, email: account.email, role: account.role, version: snapshot.version });
    }
    await mergeLegacyAccounts(c.env, retained.email, retained.id, merge.snapshots.filter(s => s.id !== retained.id).map(s => s.id), expected);
    row.user_id = retained.id;
    row.version = merge.snapshots.find(s => s.id === retained.id)!.version;
    row.credentials_hash = merge.snapshots.find(s => s.id === retained.id)!.hash;
  }
  return finishLogin(c, row);
}
export async function beginPasskeyLogin(c: Ctx, remember: boolean, target: string) {
  const rp = relyingParty(c);
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required' });
  await newChallenge(c, null, 'passkey-login', { remember, destination: destination(target), challenge: options.challenge });
  return options;
}
export async function verifyPasskeyLogin(c: Ctx, response: AuthenticationResponseJSON) {
  const row = await challenge(c, ['passkey-login']);
  const key = await repo.credential(c.env, response.id);
  if (!key) { await attempt(c, row); throw new AppError('security.invalid_code', 401); }
  const config = await repo.state(c.env, key.user_id);
  if (response.response.userHandle !== config.webauthn_user_id) { await attempt(c, row); throw new AppError('security.invalid_code', 401); }
  row.user_id = key.user_id; row.version = config.version; row.credentials_hash = await credentialsHash(c.env, key.user_id);
  await c.env.DB.prepare('UPDATE security_challenges SET user_id = ?, version = ?, credentials_hash = ? WHERE id = ? AND user_id IS NULL AND claim IS NULL').bind(row.user_id, row.version, row.credentials_hash, row.id).run();
  await consumeProof(c, row, 'passkey', '', response);
  return finishLogin(c, row);
}

type Mutation = (guard: string) => D1PreparedStatement[];
export async function mutateSecurity(c: Ctx, mutation: Mutation, issueRecovery = false, expected?: { row?: repo.ChallengeRow; claim?: string; version?: number }) {
  const user = await assertReauth(c), config = await repo.state(c.env, user.id), session = c.get('sessionId')!;
  const version = expected?.row?.version ?? expected?.version;
  if (version !== undefined && version !== null && config.version !== version) throw new AppError('security.challenge_expired', 401);
  const claim = randomToken(), now = Date.now();
  const guard = `EXISTS (SELECT 1 FROM security_reauth WHERE session_id = '${session}' AND claim = '${claim}')`;
  const recoveryCodes = issueRecovery ? Array.from({ length: 10 }, () => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')) : [];
  const proofGuard = expected?.row ? ' AND EXISTS (SELECT 1 FROM security_challenges WHERE id = ? AND user_id = ? AND version = ? AND expires_at > ? AND claim IS ? AND attempts <= 5)' : '';
  const proofValues = expected?.row ? [expected.row.id, user.id, config.version, now, expected.claim ?? null] : [];
  const statements = [c.env.DB.prepare("UPDATE security_reauth SET claim = ? WHERE session_id = ? AND user_id = ? AND version = ? AND expires_at > ? AND claim IS NULL AND EXISTS (SELECT 1 FROM account_security WHERE user_id = ? AND version = ?) AND EXISTS (SELECT 1 FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ? AND sessions.absolute_expires_at > ? AND users.role != 'banned')" + proofGuard + ' RETURNING session_id').bind(claim, session, user.id, config.version, now, user.id, config.version, session, now, now, ...proofValues), ...mutation(guard)];
  if (issueRecovery) {
    statements.push(c.env.DB.prepare(`DELETE FROM recovery_codes WHERE user_id = ? AND ${guard}`).bind(user.id));
    for (const code of recoveryCodes) statements.push(c.env.DB.prepare(`INSERT INTO recovery_codes (id, user_id) SELECT ?, ? WHERE ${guard}`).bind(await hashToken(`${user.id}:${code}`), user.id));
  }
  statements.push(
    c.env.DB.prepare(`UPDATE account_security SET version = version + 1 WHERE user_id = ? AND ${guard}`).bind(user.id),
    c.env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND ${guard}`).bind(now, user.id, session),
    c.env.DB.prepare(`DELETE FROM security_challenges WHERE user_id = ? AND ${guard}`).bind(user.id),
    c.env.DB.prepare(`DELETE FROM security_reauth WHERE user_id = ? AND session_id != ? AND ${guard}`).bind(user.id, session),
    c.env.DB.prepare('UPDATE security_reauth SET version = version + 1, claim = NULL WHERE session_id = ? AND claim = ?').bind(session, claim),
  );
  const result = await c.env.DB.batch(statements);
  if (!result[0]!.results.length) throw new AppError('security.reauth_required', 403);
  return { ok: true, recoveryCodes };
}
export async function beginEnrollment(c: Ctx, method: 'email' | 'totp') {
  const user = await assertReauth(c), config = await repo.state(c.env, user.id);
  if (method === 'email') {
    if (config.email_enabled) throw fail.conflict('security.method_exists');
    if (!(await status(c)).emailAvailable) throw new AppError('security.unavailable', 503);
    const row = await newChallenge(c, user.id, 'email-enroll'); await sendChallengeEmail(c, row);
    return { ok: true };
  }
  if (config.totp_secret) throw fail.conflict('security.method_exists');
  const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
  await newChallenge(c, user.id, 'totp-enroll', { secret: await encryptSecret(secret, c.env.MFA_ENCRYPTION_KEY, user.id) });
  const issuer = await getSetting(c.env, 'site_name');
  return { secret, uri: `otpauth://totp/${encodeURIComponent(`${issuer}:${user.email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` };
}
export async function confirmEnrollment(c: Ctx, method: 'email' | 'totp', code: string) {
  const user = await assertReauth(c), row = await challenge(c, [`${method}-enroll`]);
  const first = !(await status(c)).enabled;
  const claim = await consumeProof(c, row, method, code);
  return mutateSecurity(c, guard => [method === 'email'
    ? c.env.DB.prepare(`UPDATE account_security SET email_enabled = 1 WHERE user_id = ? AND ${guard}`).bind(user.id)
    : c.env.DB.prepare(`UPDATE account_security SET totp_secret = ? WHERE user_id = ? AND ${guard}`).bind((JSON.parse(row.payload) as Payload).secret!, user.id)], first, { row, claim });
}
export async function registrationOptions(c: Ctx) {
  const user = await assertReauth(c), config = await repo.state(c.env, user.id), rp = relyingParty(c);
  const existing = await repo.keys(c.env, user.id);
  if (existing.length >= 20) throw fail.invalid();
  const options = await generateRegistrationOptions({ rpID: rp.rpID, rpName: await getSetting(c.env, 'site_name'),
    userID: new Uint8Array(base64url.decode(config.webauthn_user_id)), userName: user.email, attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.map(key => ({ id: key.id, transports: JSON.parse(key.transports) as AuthenticatorTransportFuture[] })) });
  await newChallenge(c, user.id, 'passkey-enroll', { challenge: options.challenge });
  return options;
}
export async function confirmPasskey(c: Ctx, response: RegistrationResponseJSON, name: string) {
  const user = await assertReauth(c), row = await challenge(c, ['passkey-enroll']), rp = relyingParty(c);
  await attempt(c, row);
  let verified;
  try { verified = await verifyRegistrationResponse({ response, expectedChallenge: (JSON.parse(row.payload) as Payload).challenge!, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true }); }
  catch { throw new AppError('security.invalid_code', 401); }
  if (!verified.verified || !verified.registrationInfo) throw new AppError('security.invalid_code', 401);
  if (await repo.credential(c.env, response.id)) throw fail.conflict('security.method_exists');
  const info = verified.registrationInfo, first = !(await status(c)).enabled;
  return mutateSecurity(c, guard => [c.env.DB.prepare(`INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, device_type, backed_up, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`)
    .bind(info.credential.id, user.id, name, base64url.encode(info.credential.publicKey), info.credential.counter, JSON.stringify(info.credential.transports ?? []), info.credentialDeviceType, Number(info.credentialBackedUp), Date.now())], first, { row });
}
export async function removeMethod(c: Ctx, method: 'email' | 'totp' | 'passkey', id?: string) {
  const user = await assertReauth(c), config = await repo.state(c.env, user.id), current = await status(c);
  const count = Number(current.email) + Number(current.totp) + current.passkeys.length;
  if (count <= 1) throw fail.conflict('security.last_method');
  if (method === 'email' && !current.email || method === 'totp' && !current.totp || method === 'passkey' && !current.passkeys.some(k => k.id === id)) throw fail.notFound();
  return mutateSecurity(c, guard => [method === 'passkey'
    ? c.env.DB.prepare(`DELETE FROM passkeys WHERE id = ? AND user_id = ? AND ${guard}`).bind(id!, user.id)
    : c.env.DB.prepare(`UPDATE account_security SET ${method === 'email' ? 'email_enabled = 0' : 'totp_secret = NULL, totp_last_step = -1'} WHERE user_id = ? AND ${guard}`).bind(user.id)], false, { version: config.version });
}
export async function disable(c: Ctx) {
  const user = await assertReauth(c);
  return mutateSecurity(c, guard => [
    c.env.DB.prepare(`UPDATE account_security SET email_enabled = 0, totp_secret = NULL, totp_last_step = -1 WHERE user_id = ? AND ${guard}`).bind(user.id),
    c.env.DB.prepare(`DELETE FROM passkeys WHERE user_id = ? AND ${guard}`).bind(user.id),
    c.env.DB.prepare(`DELETE FROM recovery_codes WHERE user_id = ? AND ${guard}`).bind(user.id),
  ]);
}
export async function beginEmailChange(c: Ctx, email: string) {
  const user = await assertReauth(c);
  if (user.email.toLowerCase() === email.toLowerCase()) throw fail.invalid();
  const domainVerdict = await checkEmailDomain(c.env, email);
  if (domainVerdict) throw fail.forbidden(domainVerdict);
  if (await c.env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ? AND merged_into_user_id IS NULL').bind(email, user.id).first()) throw fail.conflict('auth.email_taken');
  const row = await newChallenge(c, user.id, 'change-email', { email }); await sendChallengeEmail(c, row);
}
export async function confirmEmailChange(c: Ctx, code: string) {
  const user = await assertReauth(c), row = await challenge(c, ['change-email']);
  const claim = await consumeProof(c, row, 'email', code);
  const email = (JSON.parse(row.payload) as Payload).email!;
  let result;
  try { result = await mutateSecurity(c, guard => [
    c.env.DB.prepare(`UPDATE users SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ? AND ${guard}`).bind(email, Date.now(), Date.now(), user.id),
    c.env.DB.prepare(`UPDATE verification_tokens SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL AND ${guard}`).bind(Date.now(), user.id),
    c.env.DB.prepare(`UPDATE password_reset_tokens SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL AND ${guard}`).bind(Date.now(), user.id),
  ], false, { row, claim }); }
  catch (error) { if (String(error).includes('UNIQUE')) throw fail.conflict('auth.email_taken'); throw error; }
  c.executionCtx.waitUntil(Promise.allSettled([user.email, email].map(to => sendEmail(c.env, { kind: 'email-changed', to, nickname: user.nickname, oldEmail: user.email, newEmail: email, locale: user.locale }))));
  return result;
}
