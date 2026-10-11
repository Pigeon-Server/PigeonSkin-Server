import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';
import { officialTextures } from '@pigeon-skin/shared/official-textures';
import { encodePng, sha256Hex } from '@pigeon-skin/minecraft';
import type { Bindings } from '../src/env.ts';
import { runMigrations } from './setup.ts';
import { ensureDefaultCloset, ensureOfficialCatalog, resetOfficialCatalogCache } from '../src/services/official-catalog.ts';
import { applyOfficialUpdates } from '../src/services/official-updates.ts';
import { capePageCandidates, candidateTexture, type ResourceCandidate } from '../src/services/official-sources.ts';

// isolatedStorage 每用例重置存储但复用 env.DB；官方目录缓存要一并失效
beforeEach(() => resetOfficialCatalogCache(env.DB));
beforeAll(runMigrations);
const configured = () => ({ ...env, OFFICIAL_CATALOG_ENABLED: 'true' } as Bindings);
async function user(email: string) {
  return (await env.DB.prepare("INSERT INTO users (email,nickname,password_hash,created_at,updated_at) VALUES (?,'Player','',1,1) RETURNING id").bind(email).first<{ id: number }>())!.id;
}
describe('official resource updates', () => {
  it('supports raw archive inflation in the Workers runtime', () => {
    const decoded = inflateRawSync(Uint8Array.from([203, 72, 205, 201, 201, 7, 0]), { maxOutputLength: 256 });
    expect(new TextDecoder().decode(decoded)).toBe('hello');
  });
  it('discovers texture IDs without trusting external download URLs', () => {
    const hash = officialTextures.find(asset => asset.kind === 'cape')!.hash;
    const candidates = capePageCandidates('New Cape', '|texture-id=' + hash + '\n|url=https://untrusted.invalid/private');
    expect(candidates[0]?.source).toBe('https://textures.minecraft.net/texture/' + hash);
  });
  it('rejects sources outside Mojang without making a network request', async () => {
    await expect(candidateTexture({ key: 'cape.invalid', name: 'Invalid', kind: 'cape', model: null, hash: 'a'.repeat(64), source: 'https://example.com/texture.png', sourcePage: '' })).rejects.toThrow('Invalid texture source');
  });
  it('uses verified PNG content hashes independently of Mojang texture IDs', async () => {
    await ensureOfficialCatalog(configured());
    const existing = officialTextures.find(asset => asset.kind === 'cape')!;
    const upstreamId = 'a'.repeat(64), candidate = capePageCandidates('Content Hash Cape', '|texture-id=' + upstreamId)[0]!;
    fetchMock.activate(); fetchMock.disableNetConnect();
    fetchMock.get('https://textures.minecraft.net').intercept({ path: '/texture/' + upstreamId }).reply(200, Buffer.from(existing.png, 'base64'));
    try {
      expect(await applyOfficialUpdates(configured(), [candidate])).toEqual({ added: 0, updated: 0 });
      fetchMock.assertNoPendingInterceptors();
    } finally { fetchMock.deactivate(); }
  });
  it('updates stable IDs, preserves removed and renamed collections, and grants only new items', async () => {
    await ensureOfficialCatalog(configured());
    const owner = await user('updated@example.com'), removed = await user('removed@example.com');
    await ensureDefaultCloset(configured(), owner); await ensureDefaultCloset(configured(), removed);
    const original = officialTextures.find(asset => asset.key === 'skin.steve.wide')!;
    const replacement = officialTextures.find(asset => asset.key === 'skin.alex.wide')!;
    const existing = (await env.DB.prepare('SELECT id,catalog_revision FROM textures WHERE official_key=?').bind(original.key).first<{ id: number; catalog_revision: number }>())!;
    await env.DB.prepare("UPDATE closet SET item_name='My custom name' WHERE user_id=? AND texture_id=?").bind(owner, existing.id).run();
    await env.DB.prepare('DELETE FROM closet WHERE user_id=? AND texture_id=?').bind(removed, existing.id).run();
    const role = (await env.DB.prepare("INSERT INTO players (user_id,name,skin_texture_id,created_at,updated_at) VALUES (?,'UpdatedPlayer',?,1,1) RETURNING id").bind(owner, existing.id).first<{ id: number }>())!;
    await env.DB.prepare("INSERT INTO uuid (player_id,name,uuid,version) VALUES (?,'UpdatedPlayer','00112233445566778899aabbccddeeff',1)").bind(role.id).run();
    const rgba = new Uint8Array(64 * 32 * 4).fill(128), bytes = Uint8Array.from(await encodePng(64, 32, rgba));
    const added: ResourceCandidate = { key: 'cape.new-resource', name: 'New resource', kind: 'cape', model: null, hash: await sha256Hex(bytes), source: 'https://textures.minecraft.net/texture/test', sourcePage: '', bytes };
    const result = await applyOfficialUpdates(configured(), [{ ...original, hash: replacement.hash, bytes: Uint8Array.from(atob(replacement.png), value => value.charCodeAt(0)) }, added]);
    expect(result).toEqual({ added: 1, updated: 1 });
    expect(await env.DB.prepare('SELECT id,hash,catalog_revision FROM textures WHERE official_key=?').bind(original.key).first()).toMatchObject({ id: existing.id, hash: replacement.hash, catalog_revision: 1 });
    await ensureDefaultCloset(configured(), owner); await ensureDefaultCloset(configured(), removed);
    expect(await env.DB.prepare('SELECT item_name FROM closet WHERE user_id=? AND texture_id=?').bind(owner, existing.id).first()).toMatchObject({ item_name: 'My custom name' });
    expect(await env.DB.prepare('SELECT texture_id FROM closet WHERE user_id=? AND texture_id=?').bind(removed, existing.id).first()).toBeNull();
    const newId = (await env.DB.prepare('SELECT id FROM textures WHERE official_key=?').bind(added.key).first<{ id: number }>())!.id;
    for (const id of [owner, removed]) expect(await env.DB.prepare('SELECT is_default FROM closet WHERE user_id=? AND texture_id=?').bind(id, newId).first()).toMatchObject({ is_default: 1 });
    expect((await env.DB.prepare('SELECT updated_at FROM players WHERE id=?').bind(role.id).first<{ updated_at: number }>())?.updated_at).toBeGreaterThan(1);
    expect(await env.DB.prepare('SELECT version FROM uuid WHERE player_id=?').bind(role.id).first()).toMatchObject({ version: 2 });
  });
});
