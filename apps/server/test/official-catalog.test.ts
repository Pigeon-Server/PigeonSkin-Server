import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { officialTextures } from '@pigeon-skin/shared/official-textures';
import { textureObjectKey, validateTexture } from '@pigeon-skin/minecraft';
import { createApp } from '../src/app.ts';
import type { Bindings } from '../src/env.ts';
import { runMigrations } from './setup.ts';
import { ensureDefaultCloset, ensureOfficialCatalog } from '../src/services/official-catalog.ts';
import { resetOfficialCatalogCache } from '../src/services/official-catalog.ts';
import { collectTexture, removeClosetEntry } from '../src/services/social.ts';

beforeAll(runMigrations);
const configured = () => ({ ...env, OFFICIAL_CATALOG_ENABLED: 'true' } as Bindings);
// isolatedStorage 每用例重置存储但复用 env.DB 对象；完成态缓存按 DB 键缓存，
// 不清会让后续用例跳过初始化直接断言空表
beforeEach(() => resetOfficialCatalogCache(env.DB));

async function existingUser() {
  const now = Date.now();
  const row = await env.DB.prepare("INSERT INTO users (email,nickname,password_hash,score,created_at,updated_at) VALUES ('catalog@example.com','Catalog player','',0,?,?) RETURNING id").bind(now, now).first<{ id: number }>();
  return row!.id;
}
const rates = { perClosetItem: 100, perLikeAward: 0, reporterReward: 0, refundOnDelete: true, reporterScoreDelta: 0 };

describe('official catalogue', () => {
  it('includes every declared PNG with matching hashes and valid Minecraft dimensions', async () => {
    expect(officialTextures.filter(asset => asset.kind === 'skin')).toHaveLength(18);
    expect(officialTextures.filter(asset => asset.kind === 'cape')).toHaveLength(55);
    expect(new Set(officialTextures.map(asset => asset.key)).size).toBe(officialTextures.length);
    for (const asset of officialTextures) {
      const bytes = Uint8Array.from(atob(asset.png), value => value.charCodeAt(0));
      const checked = await validateTexture(bytes, { kind: asset.kind, model: asset.model });
      expect(checked.ok, asset.key).toBe(true);
      if (checked.ok) expect(checked.value.hash, asset.key).toBe(asset.hash);
    }
  });
  it('imports public resources idempotently and exposes original texture files', async () => {
    await Promise.all([ensureOfficialCatalog(configured()), ensureOfficialCatalog(configured())]);
    await ensureOfficialCatalog(configured());
    const count = await env.DB.prepare('SELECT count(*) AS n FROM textures WHERE official_key IS NOT NULL').first<{ n: number }>();
    expect(count?.n).toBe(officialTextures.length);
    for (const asset of officialTextures) expect((await env.BUCKET.head(textureObjectKey(asset.hash)))?.size).toBe(asset.sizeBytes);
    const ctx = createExecutionContext();
    const response = await createApp().fetch(new Request('https://x/api/v1/textures?per_page=100'), configured(), ctx);
    await waitOnExecutionContext(ctx);
    const list = await response.json<{ items: { official: boolean; visibility: string }[]; total: number }>();
    expect(list.total).toBe(officialTextures.length);
    expect(list.items.every(item => item.official && item.visibility === 'public')).toBe(true);
    const filtered = await createApp().fetch(new Request('https://x/api/v1/textures?official=true&kind=skin&per_page=100'), configured(), createExecutionContext());
    const officialSkins = await filtered.json<{ items: { official: boolean; kind: string; origin: string }[]; total: number }>();
    expect(officialSkins.total).toBe(18);
    expect(officialSkins.items.every(item => item.official && item.kind === 'skin' && item.origin === 'repost')).toBe(true);
  });
  it('grants free default collections once without restoring removed choices or refunding free items', async () => {
    await ensureOfficialCatalog(configured());
    const userId = await existingUser();
    await Promise.all([ensureDefaultCloset(configured(), userId), ensureDefaultCloset(configured(), userId)]);
    const rows = await env.DB.prepare('SELECT texture_id,is_default FROM closet WHERE user_id = ?').bind(userId).all<{ texture_id: number; is_default: number }>();
    expect(rows.results).toHaveLength(officialTextures.length);
    expect(rows.results.every(row => row.is_default === 1)).toBe(true);
    const id = rows.results[0]!.texture_id;
    await removeClosetEntry(configured(), { id: userId, role: 'normal' }, id, rates);
    await ensureDefaultCloset(configured(), userId);
    expect(await env.DB.prepare('SELECT texture_id FROM closet WHERE user_id = ? AND texture_id = ?').bind(userId, id).first()).toBeNull();
    expect((await env.DB.prepare('SELECT score FROM users WHERE id = ?').bind(userId).first<{ score: number }>())?.score).toBe(0);
    expect((await collectTexture(configured(), { id: userId, role: 'normal' }, id, undefined, rates)).scoreSpent).toBe(0);
    expect((await env.DB.prepare('SELECT likes FROM textures WHERE id = ?').bind(id).first<{ likes: number }>())?.likes).toBe(1);
  });
  it('rebuilds missing official rows even when the state revision claims the catalog is current', async () => {
    await ensureOfficialCatalog(configured());
    await env.DB.batch([
      env.DB.prepare('UPDATE official_catalog_state SET revision = 6 WHERE id = 1'),
      env.DB.prepare('DELETE FROM textures WHERE official_key IS NOT NULL'),
    ]);
    // 完成态缓存按 isolate 生命周期收敛；用例内模拟"运维绕过应用改库"，需手动失效
    resetOfficialCatalogCache(env.DB);
    await ensureOfficialCatalog(configured());
    const count = await env.DB.prepare('SELECT count(*) AS n FROM textures WHERE official_key IS NOT NULL').first<{ n: number }>();
    expect(count?.n).toBe(officialTextures.length);
    for (const asset of officialTextures) expect((await env.BUCKET.head(textureObjectKey(asset.hash)))?.size).toBe(asset.sizeBytes);
    // 重建不得把官方更新任务累计出的更高 revision 降级
    const state = await env.DB.prepare('SELECT revision FROM official_catalog_state WHERE id = 1').first<{ revision: number }>();
    expect(state?.revision).toBe(6);
  });
  it('rebuilds only the missing subset when part of the catalog is lost', async () => {
    await ensureOfficialCatalog(configured());
    const survivors = officialTextures.slice(0, 40).map(asset => asset.key);
    await env.DB.prepare(`DELETE FROM textures WHERE official_key IS NOT NULL AND official_key NOT IN (${survivors.map(() => '?').join(',')})`)
      .bind(...survivors).run();
    await env.DB.prepare('UPDATE official_catalog_state SET revision = 1 WHERE id = 1').run();
    resetOfficialCatalogCache(env.DB);
    await ensureOfficialCatalog(configured());
    const count = await env.DB.prepare('SELECT count(*) AS n FROM textures WHERE official_key IS NOT NULL').first<{ n: number }>();
    expect(count?.n).toBe(officialTextures.length);
  });
});
