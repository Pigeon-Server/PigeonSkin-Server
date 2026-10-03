import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { Bindings } from '../src/env.ts';
import { runMigrations, makeAdmin } from './setup.ts';
import { makePng } from '../../../packages/minecraft/test/png-builder.ts';

beforeAll(runMigrations);
const password = 'site-management-9';
async function register(suffix: string, admin = false) {
  const email = `${suffix}@example.com`;
  const response = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, playerName: suffix }) });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: number }>();
  if (admin) await makeAdmin(id);
  const login = await SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
  return { id, cookie: login.headers.get('set-cookie')!.split(';')[0]! };
}
function request(path: string, cookie: string, method = 'GET', body?: unknown) {
  return SELF.fetch(`https://x/api/v1${path}`, { method, headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
describe('site management', () => {
  it('leaves texture fields and player assignments unchanged when the visibility charge fails', async () => {
    const admin = await register('texture_admin', true);
    const user = await register('texture_user');
    const form = new FormData();
    form.set('file', new Blob([makePng({ width: 64, height: 32 })]), 'skin.png');
    form.set('name', 'Original texture'); form.set('kind', 'skin'); form.set('model', 'default'); form.set('visibility', 'public');
    const uploaded = await SELF.fetch('https://x/api/v1/textures', { method: 'POST', headers: { cookie: user.cookie, 'sec-fetch-site': 'same-origin' }, body: form });
    const texture = await uploaded.json<{ id: number }>();
    const players = await (await request('/players', user.cookie)).json<{ items: Array<{ id: number }> }>();
    const player = players.items[0]!.id;
    expect((await request(`/players/${player}/textures`, user.cookie, 'PUT', { skin: texture.id })).status).toBe(200);
    expect((await request('/admin/settings', admin.cookie, 'PATCH', { settings: [{ key: 'score_per_kb_private', value: 2000 }] })).status).toBe(200);
    expect((await request(`/textures/${texture.id}`, user.cookie, 'PATCH', { name: 'New name', kind: 'cape', visibility: 'private' })).status).toBe(402);
    const unchanged = await (await request(`/textures/${texture.id}`, user.cookie)).json<{ name: string; kind: string; visibility: string }>();
    expect(unchanged).toMatchObject({ name: 'Original texture', kind: 'skin', visibility: 'public' });
    const assigned = await (await request('/players', user.cookie)).json<{ items: Array<{ skinTextureId: number | null }> }>();
    expect(assigned.items[0]!.skinTextureId).toBe(texture.id);
  });
  it('charges a concurrent visibility change only once', async () => {
    const admin = await register('vis_admin', true);
    expect((await request('/admin/settings', admin.cookie, 'PATCH', { settings: [{ key: 'score_per_kb_private', value: 10 }, { key: 'score_per_kb_public', value: 1 }] })).status).toBe(200);
    const user = await register('visibility_user');
    const form = new FormData();
    form.set('file', new Blob([makePng({ width: 64, height: 64 })]), 'skin.png');
    form.set('name', 'Visibility texture'); form.set('kind', 'skin'); form.set('model', 'default'); form.set('visibility', 'public');
    const uploaded = await SELF.fetch('https://x/api/v1/textures', { method: 'POST', headers: { cookie: user.cookie, 'sec-fetch-site': 'same-origin' }, body: form });
    const texture = await uploaded.json<{ id: number; sizeBytes: number }>();
    const before = await (await request('/me/score', user.cookie)).json<{ score: number }>();
    const responses = await Promise.all([
      request(`/textures/${texture.id}`, user.cookie, 'PATCH', { visibility: 'private' }),
      request(`/textures/${texture.id}`, user.cookie, 'PATCH', { visibility: 'private' }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const after = await (await request('/me/score', user.cookie)).json<{ score: number }>();
    expect(after.score).toBe(before.score - Math.ceil(texture.sizeBytes / 1024) * 9);
  });
  it('awards sign-in points only once for concurrent requests', async () => {
    const user = await register('sign_user');
    const responses = await Promise.all([
      request('/me/sign-in', user.cookie, 'POST'),
      request('/me/sign-in', user.cookie, 'POST'),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 429]);
    const successful = responses.find(response => response.status === 200)!;
    const result = await successful.json<{ reward: number; score: number }>();
    const points = await (await request('/me/score', user.cookie)).json<{ score: number }>();
    expect(points.score).toBe(1000 + result.reward);
    expect(result.score).toBe(points.score);
  });
  it('validates an administrator player edit before changing any fields', async () => {
    const admin = await register('atomic_admin', true);
    const user = await register('atomic_user');
    const players = await (await request('/players', user.cookie)).json<{ items: Array<{ id: number; name: string }> }>();
    const player = players.items[0]!;
    const form = new FormData();
    form.set('file', new Blob([makePng({ width: 64, height: 64 })]), 'skin.png');
    form.set('name', 'Atomic texture'); form.set('kind', 'skin'); form.set('model', 'default'); form.set('visibility', 'public');
    const uploaded = await SELF.fetch('https://x/api/v1/textures', { method: 'POST', headers: { cookie: user.cookie, 'sec-fetch-site': 'same-origin' }, body: form });
    expect(uploaded.status).toBe(201);
    const texture = await uploaded.json<{ id: number }>();
    expect((await request(`/admin/players/${player.id}`, admin.cookie, 'PATCH', { name: 'New_QA', ownerId: 999999, skin: texture.id })).status).toBe(404);
    expect((await request(`/admin/players/${player.id}`, admin.cookie, 'PATCH', { name: 'New_QA', cape: texture.id })).status).toBe(422);
    const original = await (await request('/players', user.cookie)).json<{ items: Array<{ name: string; skinTextureId: number | null }> }>();
    expect(original.items[0]).toMatchObject({ name: player.name, skinTextureId: null });
    expect((await request(`/admin/players/${player.id}`, admin.cookie, 'PATCH', { name: 'New_QA', ownerId: admin.id, skin: texture.id, cape: null })).status).toBe(200);
    const updated = await (await request('/admin/players', admin.cookie)).json<{ items: Array<{ id: number; name: string; ownerId: number; skinTextureId: number }> }>();
    expect(updated.items.find(row => row.id === player.id)).toMatchObject({ name: 'New_QA', ownerId: admin.id, skinTextureId: texture.id });
  });
  it('prevents administrators from adding closet entries for peers', async () => {
    const admin = await register('peer_admin', true);
    const peer = await register('peer_target', true);
    const uploader = await register('peer_upload');
    const form = new FormData();
    form.set('file', new Blob([makePng({ width: 64, height: 64 })]), 'skin.png');
    form.set('name', 'Peer collection'); form.set('kind', 'skin'); form.set('model', 'default'); form.set('visibility', 'public');
    const uploaded = await SELF.fetch('https://x/api/v1/textures', { method: 'POST', headers: { cookie: uploader.cookie, 'sec-fetch-site': 'same-origin' }, body: form });
    const texture = await uploaded.json<{ id: number }>();
    const before = await env.DB.prepare('SELECT score FROM users WHERE id=?').bind(peer.id).first<{ score: number }>();
    expect((await request(`/admin/users/${peer.id}/closet`, admin.cookie, 'POST', { textureId: texture.id })).status).toBe(403);
    expect(await env.DB.prepare('SELECT texture_id FROM closet WHERE user_id=? AND texture_id=?').bind(peer.id, texture.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT score FROM users WHERE id=?').bind(peer.id).first()).toEqual(before);
  });
  it('does not add a closet entry or change collection counts when points are insufficient', async () => {
    const admin = await register('closet_admin', true);
    const user = await register('closet_user');
    const form = new FormData();
    form.set('file', new Blob([makePng({ width: 64, height: 64 })]), 'skin.png');
    form.set('name', 'Collection texture'); form.set('kind', 'skin'); form.set('model', 'default'); form.set('visibility', 'public');
    const uploaded = await SELF.fetch('https://x/api/v1/textures', { method: 'POST', headers: { cookie: admin.cookie, 'sec-fetch-site': 'same-origin' }, body: form });
    const texture = await uploaded.json<{ id: number }>();
    expect((await request('/admin/settings', admin.cookie, 'PATCH', { settings: [{ key: 'score_per_closet_item', value: 2000 }] })).status).toBe(200);
    const result = await request('/closet', user.cookie, 'POST', { textureId: texture.id });
    expect(result.status).toBe(402);
    expect((await (await request('/closet', user.cookie)).json<{ items: unknown[] }>()).items).toEqual([]);
    expect((await (await request(`/textures/${texture.id}`, user.cookie)).json<{ likes: number }>()).likes).toBe(1);
    expect((await (await request('/me/score', user.cookie)).json<{ score: number }>()).score).toBe(1000);
  });
  it('restricts translation edits and reads only the requested locale', async () => {
    const admin = await register('tr_admin', true); const user = await register('tr_user');
    const input = { locale: 'en', key: 'common.save', value: 'Store' };
    expect((await request('/admin/translations', user.cookie, 'PUT', input)).status).toBe(403);
    expect((await request('/admin/translations', admin.cookie, 'PUT', input)).status).toBe(200);
    const english = await (await request('/translations?locale=en', '')).json<{ items: unknown[] }>();
    expect(english.items).toContainEqual({ key: 'common.save', value: 'Store' });
    expect((await (await request('/translations?locale=zh_CN', '')).json<{ items: unknown[] }>()).items).toEqual([]);
    expect((await request('/admin/translations', admin.cookie, 'PUT', { ...input, key: 'common.__proto__.bad' })).status).toBe(422);
    expect((await request('/admin/translations?locale=en&key=common.save', admin.cookie, 'DELETE')).status).toBe(204);
  });
  it('protects administration and returns real status and a complete 31-day chart', async () => {
    expect((await request('/admin/status', '')).status).toBe(401);
    const admin = await register('chart_admin', true);
    const status = await (await request('/admin/status', admin.cookie)).json<{ database: boolean; storage: boolean }>();
    expect(status).toMatchObject({ database: true, storage: true });
    const chart = await (await request('/admin/chart', admin.cookie)).json<Array<{ date: string; users: number; textures: number }>>();
    expect(chart).toHaveLength(31);
    expect(new Set(chart.map(row => row.date)).size).toBe(31);
    expect(chart.reduce((sum, row) => sum + row.users, 0)).toBeGreaterThan(0);
    expect((await request('/admin/update', admin.cookie, 'POST')).status).toBe(422);
  });
  it('persists theme colors and rejects invalid accent values', async () => {
    const admin = await register('theme_admin', true);
    expect((await request('/admin/settings', admin.cookie, 'PATCH', { settings: [{ key: 'theme_color', value: '#8061a8' }] })).status).toBe(200);
    const settings = await (await request('/settings/public', '')).json<Record<string, string>>();
    expect(settings.theme_color).toBe('#8061a8');
    expect((await request('/admin/settings', admin.cookie, 'PATCH', { settings: [{ key: 'theme_color', value: 'url(example.com)' }] })).status).toBe(422);
  });
  it('filters models and uploaders and clears incompatible assignments on type changes', async () => {
    const user = await register('model_user');
    const form = new FormData(); form.set('file', new Blob([makePng({ width: 64, height: 32 })]), 'skin.png'); form.set('name', 'Model texture'); form.set('kind', 'skin'); form.set('model', 'default'); form.set('visibility', 'public');
    const response = await SELF.fetch('https://x/api/v1/textures', { method: 'POST', headers: { cookie: user.cookie, 'sec-fetch-site': 'same-origin' }, body: form });
    expect(response.status).toBe(201);
    const texture = await response.json<{ id: number }>();
    const players = await (await request('/players', user.cookie)).json<{ items: Array<{ id: number }> }>();
    const player = players.items[0]!.id;
    expect((await request(`/players/${player}/textures`, user.cookie, 'PUT', { skin: texture.id })).status).toBe(200);
    const filtered = await (await request(`/textures?model=default&uploader=${user.id}`, user.cookie)).json<{ items: Array<{ id: number }> }>();
    expect(filtered.items.map(item => item.id)).toContain(texture.id);
    const slim = await (await request('/textures?model=slim', user.cookie)).json<{ items: unknown[] }>();
    expect(slim.items).toHaveLength(0);
    expect((await request(`/textures/${texture.id}`, user.cookie, 'PATCH', { kind: 'cape' })).status).toBe(200);
    const updated = await (await request('/players', user.cookie)).json<{ items: Array<{ skinTextureId: number | null }> }>();
    expect(updated.items[0]!.skinTextureId).toBeNull();
  });
  it('initializes only once, rejects the wrong token and keeps deployment secrets private', async () => {
    const app = createApp();
    const bindings = { ...env, SETUP_TOKEN: 'local-test-only', ENVIRONMENT: 'development', APP_URL: 'https://x', TURNSTILE_ENABLED: 'false', RATE_LIMIT_ENABLED: 'false' } as unknown as Bindings;
    const call = async (token: string) => {
      const ctx = createExecutionContext();
      const response = await app.fetch(new Request('https://x/api/v1/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, siteName: 'Setup Site', email: 'setup@example.com', nickname: 'Owner', password }) }), bindings, ctx);
      await waitOnExecutionContext(ctx); return response;
    };
    expect((await call('wrong-token')).status).toBe(403);
    const responses = await Promise.all([call('local-test-only'), call('local-test-only')]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    const users = await env.DB.prepare("SELECT role FROM users WHERE email = 'setup@example.com'").all<{ role: string }>();
    expect(users.results).toEqual([{ role: 'super_admin' }]);
    const settings = await (await app.fetch(new Request('https://x/api/v1/settings/public'), bindings)).json<Record<string, string>>();
    expect(settings.site_name).toBe('Setup Site');
    expect(settings.SETUP_TOKEN).toBeUndefined();
  });
});
