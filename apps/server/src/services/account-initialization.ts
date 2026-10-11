import { hashPassword, hashToken } from '@pigeon-skin/auth';
import { isValidPlayerName, type PlayerNameRule } from '@pigeon-skin/shared';
import { emailSchema, nicknameSchema, passwordSchema, playerNameSchema } from '@pigeon-skin/shared/schemas';
import { z } from 'zod';
import { noCaseEq } from '@pigeon-skin/db';
import { fail } from '../framework.ts';
import { getSetting, getSettingBool, getSettingInt, needsAccountInitialization } from '../lib.ts';
import type { Bindings } from '../env.ts';
import { checkEmailDomain } from './email-policy.ts';

export const initializationSchema = z.object({
  email: emailSchema,
  nickname: nicknameSchema,
  password: passwordSchema,
  playerName: playerNameSchema.optional(),
  redirect: z.string().max(2000).default('/user'),
  ticket: z.string().uuid(),
});
interface InitializationAccount { email: string; nickname: string; password_hash: string; email_verified_at: number | null; updated_at: number; needs_initialization: number }
export function initializationDestination(value: string) {
  return /^\/(?!\/)[A-Za-z0-9/_?=&%+.,~-]*$/.test(value) && !value.startsWith('/auth/') ? value : '/user';
}
async function account(env: Bindings, id: number) {
  const user = await env.DB.prepare('SELECT email, nickname, password_hash, email_verified_at, updated_at, needs_initialization FROM users WHERE id = ?').bind(id).first<InitializationAccount>();
  if (!user) throw fail.unauthorized();
  return user;
}
export async function initializationStatus(env: Bindings, id: number) {
  const user = await account(env, id);
  const players = await env.DB.prepare('SELECT id FROM players WHERE user_id = ? LIMIT 1').bind(id).first();
  return {
    needsInitialization: needsAccountInitialization(user.email, user.password_hash, user.needs_initialization),
    email: /@oauth\.(?:invalid|local)$/i.test(user.email) ? '' : user.email,
    nickname: user.nickname,
    emailVerified: user.email_verified_at !== null,
    requireEmailVerification: await getSettingBool(env, 'require_email_verification'),
    playerRequired: await getSettingBool(env, 'register_with_player_name') && !players,
    playerNameMin: await getSettingInt(env, 'player_name_length_min'),
    playerNameMax: await getSettingInt(env, 'player_name_length_max'),
  };
}
export async function initializeAccount(env: Bindings, id: number, sessionId: string, input: z.input<typeof initializationSchema>) {
  const user = await account(env, id);
  if (!needsAccountInitialization(user.email, user.password_hash, user.needs_initialization)) throw fail.conflict('auth.already_initialized');
  const ticket = await hashToken(input.ticket);
  if (!await env.DB.prepare('SELECT id FROM oauth_login_states WHERE id = ? AND provider = ? AND user_id = ? AND session_id = ? AND expires_at > ?').bind(ticket, 'initialize', id, sessionId, Date.now()).first()) throw fail.conflict('auth.initialization_expired');
  const verdict = await checkEmailDomain(env, input.email);
  if (verdict) throw fail.forbidden(verdict);
  const duplicate = await env.DB.prepare(`SELECT id FROM users WHERE ${noCaseEq('email', '?')} AND id != ?`).bind(input.email, id).first();
  if (duplicate) throw fail.conflict('auth.email_taken');
  const status = await initializationStatus(env, id);
  if (status.playerRequired) {
    const name = input.playerName || '';
    if (!isValidPlayerName(name, await getSetting(env, 'player_name_rule') as PlayerNameRule, await getSetting(env, 'player_name_regexp')) || name.length < status.playerNameMin || name.length > status.playerNameMax) throw fail.invalid('player.name_invalid', { playerName: 'invalid' });
    if (await env.DB.prepare(`SELECT id FROM players WHERE ${noCaseEq('name', '?')}`).bind(name).first()) throw fail.conflict('auth.player_name_taken');
  }
  const passwordHash = await hashPassword(input.password), now = Date.now();
  const verifiedAt = user.email.toLowerCase() === input.email.toLowerCase() ? user.email_verified_at : null;
  try {
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE users SET email = ?, nickname = ?, password_hash = ?, needs_initialization = 0, password_rehash_required = 0, email_verified_at = ?, updated_at = ? WHERE id = ? AND password_hash = ? AND email = ? AND updated_at = ? AND role != 'banned' AND EXISTS (SELECT 1 FROM oauth_login_states WHERE id = ? AND provider = 'initialize' AND user_id = ? AND session_id = ? AND expires_at > ?) RETURNING id").bind(input.email, input.nickname, passwordHash, verifiedAt, now, id, user.password_hash, user.email, user.updated_at, ticket, id, sessionId, now),
      ...(status.playerRequired ? [env.DB.prepare('INSERT INTO players (user_id, name, created_at, updated_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ? AND updated_at = ?) AND NOT EXISTS (SELECT 1 FROM players WHERE user_id = ?)').bind(id, input.playerName!, now, now, id, passwordHash, now, id)] : []),
      env.DB.prepare('DELETE FROM oauth_login_states WHERE id = ? AND user_id = ? AND session_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)').bind(ticket, id, sessionId, id, passwordHash),
    ]);
    if (!results[0]?.meta.changes) throw fail.conflict('auth.initialization_expired');
  } catch (error) {
    if (String(error).includes('UNIQUE') && String(error).includes('users.email')) throw fail.conflict('auth.email_taken');
    if (String(error).includes('UNIQUE') && String(error).includes('players.name')) throw fail.conflict('auth.player_name_taken');
    throw error;
  }
  return { redirect: initializationDestination(input.redirect ?? '/user'), needsEmailVerification: status.requireEmailVerification && verifiedAt === null };
}
