import type { Context } from 'hono';
import { hashToken } from '@pigeon-skin/auth';
import { base64url } from 'jose';
import { getSettingInt, type AppEnv } from '../lib.ts';
import { AppError } from '../framework.ts';

export const PIGEON_SCOPES = ['players.read', 'users.read', 'users.email', 'admin.texture.import', 'admin.users.write', 'admin.textures.write', 'admin.stats.read', 'admin.settings.write'] as const;
export interface PigeonKey {
  id: string; label: string; scopes: string;
  enabled: number; usage_count: number; created_at: number; last_used_at: number | null;
  created_by: number | null;
}
export async function requirePigeonKey(c: Context<AppEnv>, scope?: string) {
  const raw = c.req.header('api-key') || c.req.header('authorization')?.replace(/^Bearer /, '') || '';
  if (!raw || raw.length > 200) throw new AppError('pigeon.key_invalid', 401);
  const hash = await hashToken(raw);
  const key = await c.env.DB.prepare('SELECT id, label, scopes, enabled, usage_count, created_at, last_used_at, created_by FROM pigeon_api_keys WHERE secret_hash = ? AND enabled = 1 AND revoked_at IS NULL').bind(hash).first<PigeonKey>();
  if (!key) throw new AppError('pigeon.key_invalid', 401);
  if (scope && !(JSON.parse(key.scopes) as string[]).includes(scope)) throw new AppError('pigeon.scope_denied', 403);
  const now = Date.now(), window = Math.max(1, Math.min(3600, Math.trunc(await getSettingInt(c.env, 'pigeon_api_window_seconds')))) * 1000, limit = Math.max(1, Math.min(10000, Math.trunc(await getSettingInt(c.env, 'pigeon_api_request_limit'))));
  const accepted = await c.env.DB.prepare('UPDATE pigeon_api_keys SET window_count = CASE WHEN window_start <= ? THEN 1 ELSE window_count + 1 END, window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END, usage_count = usage_count + 1, last_used_at = ? WHERE id = ? AND enabled = 1 AND revoked_at IS NULL AND (window_start <= ? OR window_count < ?) RETURNING id')
    .bind(now - window, now - window, now, now, key.id, now - window, limit).first();
  if (!accepted) {
    c.header('Retry-After', String(Math.ceil(window / 1000)));
    throw new AppError('pigeon.rate_limited', 429);
  }
  return key;
}
export async function newPigeonSecret() {
  const secret = `psk_${base64url.encode(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { secret, hash: await hashToken(secret), prefix: secret.slice(0, 12) };
}
