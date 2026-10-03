import { hashToken } from '@pigeon-skin/auth';
import { getSetting, type AppEnv } from '../lib.ts';
import type { Context } from 'hono';

export interface GameProfile { id: string; name: string; playerId: number; version: number }
export function publicProfile(p: GameProfile) { return { id: p.id, name: p.name }; }
export async function uuidForPlayer(c: Context<AppEnv>, playerId: number): Promise<GameProfile> {
  const existing = await c.env.DB.prepare('SELECT uuid AS id, name, player_id AS playerId, version FROM uuid WHERE player_id = ?').bind(playerId).first<GameProfile>();
  if (existing) return existing;
  const player = await c.env.DB.prepare('SELECT name FROM players WHERE id = ?').bind(playerId).first<{ name: string }>();
  if (!player) throw new Error('Player not found');
  let uuid = crypto.randomUUID().replace(/-/g, '');
  if (await getSetting(c.env, 'ygg_uuid_algorithm') === 'v3') {
    const bytes = new Uint8Array(await crypto.subtle.digest('MD5', new TextEncoder().encode(`OfflinePlayer:${player.name}`)));
    bytes[6] = (bytes[6]! & 15) | 48;
    bytes[8] = (bytes[8]! & 63) | 128;
    uuid = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  await c.env.DB.prepare('INSERT INTO uuid (player_id, name, uuid) SELECT id, name, ? FROM players WHERE id = ? ON CONFLICT(player_id) DO NOTHING').bind(uuid, playerId).run();
  return (await c.env.DB.prepare('SELECT uuid AS id, name, player_id AS playerId, version FROM uuid WHERE player_id = ?').bind(playerId).first<GameProfile>())!;
}
export async function gameProfiles(c: Context<AppEnv>, userId: number) {
  const { results } = await c.env.DB.prepare('SELECT id FROM players WHERE user_id = ? ORDER BY id').bind(userId).all<{ id: number }>();
  return Promise.all(results.map(p => uuidForPlayer(c, p.id)));
}
export async function userUuid(userId: number) { return (await hashToken(`blessing:user:${userId}`)).slice(0, 32); }
