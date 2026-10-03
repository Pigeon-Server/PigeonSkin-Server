import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { runMigrations } from './setup.ts';
import { invalidateSettingsCache } from '../src/lib.ts';
import { deleteTexture } from '../src/services/textures.ts';
import { deletePlayer } from '../src/services/players.ts';
import { createApp } from '../src/app.ts';

beforeAll(runMigrations);

async function seedUser(email: string, score = 1000) {
  const now = Date.now();
  const row = await env.DB.prepare("INSERT INTO users(email,nickname,password_hash,role,score,created_at,updated_at) VALUES(?,?,'test-hash','normal',?,?,?) RETURNING id")
    .bind(email, email.split('@')[0], score, now, now).first<{ id: number }>();
  return row!.id;
}

async function seedTexture(hash: string, uploaderId: number, refundBasis = 0) {
  const now = Date.now();
  const row = await env.DB.prepare("INSERT INTO textures(hash,kind,model,name,uploader_id,size_bytes,score_refund_basis,visibility,width,height,likes,created_at,updated_at) VALUES(?,'skin','default','skin',?,128,?,'private',64,64,0,?,?) RETURNING id")
    .bind(hash, uploaderId, refundBasis, now, now).first<{ id: number }>();
  return row!.id;
}

async function hash(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function request(path: string) {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(new Request(`https://x${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('纹理协议可见性', () => {
  it('未公开的私有纹理不可从匿名协议出口读取，穿戴后才可供游戏加载', async () => {
    const ownerId = await seedUser(`private-${crypto.randomUUID()}@example.com`);
    const hiddenHash = await hash(crypto.randomUUID());
    const hiddenId = await seedTexture(hiddenHash, ownerId);
    const wornHash = await hash(crypto.randomUUID());
    const wornId = await seedTexture(wornHash, ownerId);
    const playerName = `Worn${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const now = Date.now();
    await env.DB.prepare('INSERT INTO players(user_id,name,skin_texture_id,score_paid,created_at,updated_at) VALUES(?,?,?,0,?,?)')
      .bind(ownerId, playerName, wornId, now, now).run();
    await env.DB.prepare("INSERT INTO settings(key,locale,value,updated_at) VALUES('allow_texture_download','', 'true', ?) ON CONFLICT(key,locale) DO UPDATE SET value='true',updated_at=excluded.updated_at")
      .bind(now).run();
    invalidateSettingsCache();

    expect((await request(`/textures/${hiddenHash}`)).status).toBe(403);
    expect((await request(`/raw/${hiddenId}`)).status).toBe(403);
    expect((await request(`/usm/textures/${hiddenHash}`)).status).toBe(404);
    expect((await request(`/avatar/${hiddenHash}?size=64`)).status).toBe(404);
    expect((await request(`/preview/${hiddenHash}`)).status).toBe(404);

    const profile = await request(`/${playerName}.json`);
    expect(profile.status).toBe(200);
    expect((await request(`/textures/${wornHash}`)).status).toBe(503);
    expect((await request(`/raw/${wornId}`)).status).toBe(503);

  });
});

describe('积分快照并发结算', () => {
  it('并发删除纹理只执行一次退款', async () => {
    const ownerId = await seedUser(`refund-texture-${crypto.randomUUID()}@example.com`, 100);
    const imageHash = await hash(crypto.randomUUID());
    const textureId = await seedTexture(imageHash, ownerId, 73);
    await seedTexture(imageHash, ownerId, 0);
    const actor = { id: ownerId, email: 'refund@example.com', nickname: 'refund', role: 'normal' as const, score: 100, emailVerifiedAt: null, locale: null, isDarkMode: false, avatarTextureId: null, signature: '', needsInitialization: false };
    const results = await Promise.allSettled([1, 2].map(() => deleteTexture(env, actor, textureId, { enabled: true })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const user = await env.DB.prepare('SELECT score FROM users WHERE id=?').bind(ownerId).first<{ score: number }>();
    expect(user?.score).toBe(173);
  });

  it('删除免费创建的玩家不产生退款，付费玩家按实付快照退款一次', async () => {
    const ownerId = await seedUser(`refund-player-${crypto.randomUUID()}@example.com`, 20);
    const now = Date.now();
    const free = await env.DB.prepare("INSERT INTO players(user_id,name,score_paid,created_at,updated_at) VALUES(?,'FreePlayer',0,?,?) RETURNING id").bind(ownerId, now, now).first<{ id: number }>();
    await deletePlayer({ DB: env.DB }, { id: ownerId, role: 'normal' }, free!.id, { enabled: true });
    const paid = await env.DB.prepare("INSERT INTO players(user_id,name,score_paid,created_at,updated_at) VALUES(?,'PaidPlayer',41,?,?) RETURNING id").bind(ownerId, now + 1, now + 1).first<{ id: number }>();
    const results = await Promise.allSettled([1, 2].map(() => deletePlayer({ DB: env.DB }, { id: ownerId, role: 'normal' }, paid!.id, { enabled: true })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const user = await env.DB.prepare('SELECT score FROM users WHERE id=?').bind(ownerId).first<{ score: number }>();
    expect(user?.score).toBe(61);
  });
});
