import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { builtinLive2DModels } from '@pigeon-skin/shared/live2d';
import { makeAdmin, runMigrations } from './setup.ts';
import { unpackModel } from '../src/services/live2d.ts';

beforeAll(runMigrations);

it('live2d display is disabled by default until an admin enables it', async () => {
  const display = await (await SELF.fetch('https://x/api/v1/live2d')).json<{ enabled: boolean }>();
  expect(display.enabled).toBe(false);
});

function archive(extra: Record<string, Uint8Array> = {}, settings: unknown = { model: 'model.moc', textures: ['textures/skin.png'], motions: { idle: [{ file: 'idle.mtn' }] } }) {
  return zipSync({
    'character/entry.json': strToU8(JSON.stringify(settings)),
    'character/model.moc': strToU8('model'),
    'character/textures/skin.png': new Uint8Array([137, 80, 78, 71]),
    'character/idle.mtn': strToU8('motion'),
    ...extra,
  });
}

async function register(name: string, admin = false) {
  const credentials = { email: `${name}@example.com`, password: 'live2d-test-2026', playerName: name };
  const response = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: number }>();
  if (admin) await makeAdmin(id);
  const login = await SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: credentials.email, password: credentials.password }) });
  return login.headers.get('set-cookie')!.split(';')[0]!;
}

function upload(cookie: string, bytes: Uint8Array) {
  const body = new FormData();
  body.set('name', 'Uploaded model');
  body.set('file', new Blob([bytes]), 'model.zip');
  return SELF.fetch('https://x/api/v1/admin/live2d/models', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' }, body });
}

describe('Live2D model packages', () => {
  it('preserves a nested Cubism 2 package and resolves every motion resource', () => {
    const result = unpackModel(archive());
    expect(result.entry).toBe('character/entry.json');
    expect(result.version).toBe(2);
    expect(result.files.size).toBe(4);
  });

  it('supports Cubism 3/4 file references', () => {
    const bytes = zipSync({
      'model.model3.json': strToU8(JSON.stringify({ Version: 3, FileReferences: { Moc: 'model.moc3', Textures: ['tex.png'], Motions: { Idle: [{ File: 'idle.motion3.json' }] } } })),
      'model.moc3': strToU8('model'), 'tex.png': new Uint8Array([137, 80, 78, 71]),
      'idle.motion3.json': strToU8('{}'),
    });
    expect(unpackModel(bytes).version).toBe(4);
  });

  it('rejects missing files, remote references, traversal and executable assets', () => {
    for (const model of ['missing.moc', 'https://example.com/model.moc', '../../outside.moc']) {
      expect(() => unpackModel(archive({}, { model, textures: ['textures/skin.png'] }))).toThrow();
    }
    expect(() => unpackModel(archive({ '../outside.txt': strToU8('unsafe') }))).toThrow();
    expect(() => unpackModel(archive({ 'character/script.js': strToU8('alert(1)') }))).toThrow();
  });

  it('rejects multiple entries, corrupt ZIPs, and oversized expanded assets', () => {
    expect(() => unpackModel(archive({ 'second.json': strToU8(JSON.stringify({ model: 'character/model.moc', textures: ['character/textures/skin.png'] })) }))).toThrow();
    expect(() => unpackModel(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => unpackModel(archive({ 'large.txt': new Uint8Array(33 * 1024 * 1024) }))).toThrow();
  });
});

describe('Live2D administration', () => {
  it('includes the pinned default model library and accepts both SDK versions', async () => {
    const defaults = builtinLive2DModels.filter(model => model.id.startsWith('imuncle-'));
    expect(defaults.length).toBe(252);
    expect(new Set(defaults.map(model => model.id)).size).toBe(defaults.length);
    const cookie = await register('live2d_catalog', true);
    for (const version of [2, 4]) {
      const model = defaults.find(model => model.version === version)!;
      expect(model.url).toContain('b5caf5390c8c226f19c817ea37d5bc4452d85209');
      const response = await SELF.fetch('https://x/api/v1/admin/live2d', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, modelId: model.id }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ modelId: model.id, model: { url: model.url } });
    }
  });
  it('allows visitors to read the display but restricts uploads and selection to admins', async () => {
    expect((await SELF.fetch('https://x/api/v1/live2d')).status).toBe(200);
    expect((await SELF.fetch('https://x/api/v1/admin/live2d')).status).toBe(401);
    const cookie = await register('live2d_user');
    expect((await upload(cookie, archive())).status).toBe(403);
    expect((await SELF.fetch('https://x/api/v1/admin/live2d', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, modelId: 'aoba' }) })).status).toBe(403);
  });

  it('uploads to R2, serves nested assets, persists selection and turns display off', async () => {
    const cookie = await register('live2d_admin', true);
    const response = await upload(cookie, archive());
    expect(response.status).toBe(201);
    const model = await response.json<{ id: string; url: string }>();
    const asset = await SELF.fetch(`https://x${model.url}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('application/json');
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await asset.json<{ model: string }>()).model).toBe('model.moc');
    const texture = await SELF.fetch(`https://x${new URL('textures/skin.png', `https://x${model.url}`).pathname}`);
    expect(texture.status).toBe(200);
    await texture.arrayBuffer();
    const put = (enabled: boolean, modelId = model.id) => SELF.fetch('https://x/api/v1/admin/live2d', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled, modelId }) });
    expect((await put(true)).status).toBe(200);
    const display = await (await SELF.fetch('https://x/api/v1/live2d')).json<{ enabled: boolean; modelId: string }>();
    expect(display).toMatchObject({ enabled: true, modelId: model.id });
    const list = await (await SELF.fetch('https://x/api/v1/admin/live2d', { headers: { cookie } })).json<{ items: Array<{ id: string }> }>();
    expect(list.items.map(item => item.id)).toContain(model.id);
    expect((await put(true, 'missing')).status).toBe(404);
    expect((await put(false)).status).toBe(200);
    expect(await (await SELF.fetch('https://x/api/v1/live2d')).json()).toMatchObject({ enabled: false });
  });

  it('does not leave R2 objects behind after validation fails', async () => {
    const cookie = await register('live2d_invalid', true);
    const before = await env.BUCKET.list({ prefix: 'live2d/' });
    expect((await upload(cookie, archive({ 'unsafe.html': strToU8('<script></script>') }))).status).toBe(422);
    const after = await env.BUCKET.list({ prefix: 'live2d/' });
    expect(after.objects.map(item => item.key)).toEqual(before.objects.map(item => item.key));
  });
});
