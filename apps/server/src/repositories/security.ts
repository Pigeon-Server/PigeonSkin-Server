import type { Bindings } from '../env.ts';
import { randomToken } from '../services/security-crypto.ts';

export interface SecurityRow {
  user_id: number; version: number; email_enabled: number; totp_secret: string | null;
  totp_last_step: number; webauthn_user_id: string;
}
export interface CredentialRow {
  id: string; user_id: number; name: string; public_key: string; counter: number;
  transports: string; device_type: string; backed_up: number; created_at: number;
}
export interface ChallengeRow {
  id: string; browser_hash: string; user_id: number | null; session_id: string | null;
  purpose: string; version: number | null; credentials_hash: string | null;
  payload: string; attempts: number; email_hash: string | null;
  email_expires_at: number | null; mail_sent_at: number | null; claim: string | null;
  created_at: number; expires_at: number;
}
type Env = Pick<Bindings, 'DB'>;
export async function state(env: Env, userId: number): Promise<SecurityRow> {
  await env.DB.prepare('INSERT OR IGNORE INTO account_security (user_id, webauthn_user_id) VALUES (?, ?)').bind(userId, randomToken()).run();
  return (await env.DB.prepare('SELECT * FROM account_security WHERE user_id = ?').bind(userId).first<SecurityRow>())!;
}
export async function keys(env: Env, userId: number) {
  return (await env.DB.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at').bind(userId).all<CredentialRow>()).results;
}
export function credential(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(id).first<CredentialRow>();
}
export function user(env: Env, id: number) {
  return env.DB.prepare('SELECT id, email, email_verified_at, nickname, password_hash, role, merged_into_user_id, needs_initialization FROM users WHERE id = ?').bind(id)
    .first<{ id: number; email: string; email_verified_at: number | null; nickname: string; password_hash: string; role: string; merged_into_user_id: number | null; needs_initialization: number }>();
}
export async function methods(env: Env, userId: number) {
  const config = await state(env, userId);
  const available: Array<'email' | 'totp' | 'passkey' | 'recovery'> = [];
  if (config.email_enabled) available.push('email');
  if (config.totp_secret) available.push('totp');
  if ((await keys(env, userId)).length) available.push('passkey');
  if (available.length && await env.DB.prepare('SELECT id FROM recovery_codes WHERE user_id = ? LIMIT 1').bind(userId).first()) available.push('recovery');
  return available;
}
