import type { TextureModel } from '@pigeon-skin/shared';
import { uploadTexture } from './textures.ts';
import { getSettingBool, getSettingInt } from '../lib.ts';
import { DEFAULT_TEXTURE_LIMITS } from '@pigeon-skin/minecraft';
import type { Bindings } from '../env.ts';

export interface YggUploadEnv {
  DB: Bindings['DB'];
  BUCKET: Bindings['BUCKET'];
}

export async function uploadTextureViaYgg(
  env: YggUploadEnv & Bindings,
  userId: number,
  playerId: number,
  kind: 'skin' | 'cape',
  model: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const playerBefore = await env.DB.prepare('SELECT updated_at FROM players WHERE id=? AND user_id=?').bind(playerId, userId).first<{ updated_at: number }>();
  if (!playerBefore) throw new Error('Player not found');
  const targetModel: TextureModel | null = kind === 'cape' ? null : model === 'slim' ? 'slim' : 'default';
  const readSetting = (key: 'max_upload_size_kb' | 'max_texture_width') => getSettingInt(env, key);
  const limits = {
    maxSizeBytes: (await readSetting('max_upload_size_kb')) * 1024,
    maxWidth: await readSetting('max_texture_width'),
    maxArea: DEFAULT_TEXTURE_LIMITS.maxArea,
  };
  const result = await uploadTexture(env, { id: userId }, {
    bytes,
    name: `${kind}_upload_${Date.now()}`,
    kind,
    model: targetModel,
    visibility: 'private',
    limits,
    addToCloset: false,
    allowDuplicateReuse: true,
  }, {
    perKbPublic: await getSettingInt(env, 'score_per_kb_public'),
    perKbPrivate: await getSettingInt(env, 'score_per_kb_private'),
    closetItem: 0,
    awardPerTexture: await getSettingInt(env, 'score_award_per_texture'),
    clawbackAward: await getSettingBool(env, 'clawback_award_on_delete'),
  });
  const column = kind === 'skin' ? 'skin_texture_id' : 'cape_texture_id';
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE players SET ${column}=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=?`)
      .bind(result.id, Date.now(), playerId, userId, playerBefore.updated_at),
    env.DB.prepare('DELETE FROM textures WHERE id=? AND ?=0 AND changes()=0 RETURNING hash').bind(result.id, Number(result.reused)),
    env.DB.prepare('UPDATE users SET score=score+? WHERE id=? AND changes()>0').bind(result.scoreSpent, userId),
  ]);
  if (!results[0]?.meta.changes) {
    const deletedHash = (results[1]?.results?.[0] as { hash?: string } | undefined)?.hash;
    if (deletedHash && await env.DB.prepare('SELECT 1 FROM textures WHERE hash=? LIMIT 1').bind(deletedHash).first() === null) {
      await env.BUCKET.delete(`textures/${deletedHash}.png`);
      await (await import('./texture-access.ts')).purgeTextureDerivatives(env, deletedHash);
    }
    throw new Error('Player assignment changed during upload');
  }
  const player = await env.DB.prepare('SELECT name FROM players WHERE id=?').bind(playerId).first<{ name: string }>();
  if (player) await (await import('./texture-access.ts')).purgePlayerProfiles(env, player.name);
}
