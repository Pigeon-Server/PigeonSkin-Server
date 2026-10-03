import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { decodePng, encodePng, renderAvatar2d, renderAvatar3d, textureObjectKey } from '@pigeon-skin/minecraft';
import { defaultAvatarModel, defaultAvatarUrls } from '@pigeon-skin/shared/default-skins';
import { hashPassword } from '@pigeon-skin/auth';
import { runMigrations } from './setup.ts';

let uid = 0, tid = 0, cookie = '';
const hash = 'a'.repeat(64);
const rgba = new Uint8Array(64 * 64 * 4);
for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) rgba.set([255, 0, 0, 255], (y * 64 + x) * 4);
for (let y = 8; y < 16; y++) for (let x = 40; x < 48; x++) rgba.set([0, 0, 255, 255], (y * 64 + x) * 4);
async function request(path: string, authenticated = false) { return SELF.fetch('https://x' + path, authenticated ? { headers: { cookie } } : undefined); }
async function setAvatar(id: number | null) {
  return SELF.fetch('https://x/api/v1/me/avatar', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ textureId: id }) });
}
beforeAll(async () => {
  await runMigrations();
  const now = Date.now();
  const user = await env.DB.prepare("INSERT INTO users (email,nickname,password_hash,role,score,created_at,updated_at) VALUES (?,?,?,'normal',1000,?,?) RETURNING id").bind('avatar@example.com', 'Avatar player', await hashPassword('avatar-password-9'), now, now).first<{ id: number }>(); uid = user!.id;
  const texture = await env.DB.prepare("INSERT INTO textures (hash,name,kind,model,visibility,size_bytes,width,height,uploader_id,created_at,updated_at) VALUES (?,?,'skin','slim','private',1,64,64,?,?,?) RETURNING id").bind(hash, 'Private skin', uid, now, now).first<{ id: number }>(); tid = texture!.id;
  const png = await encodePng(64, 64, rgba); await env.BUCKET.put(textureObjectKey(hash), png);
  const login = await SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'avatar@example.com', password: 'avatar-password-9' }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});
describe('Minecraft user avatars', () => {
  it('serves stable Steve and Alex defaults as actual PNG avatars', async () => {
    const avatars: Uint8Array[] = [];
    for (const id of [1, 2]) {
      const response = await request(`/avatar/user/${id}?size=100`); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('image/png');
      const bytes = new Uint8Array(await response.arrayBuffer()); avatars.push(bytes);
      const decoded = await decodePng(bytes); expect(decoded.ok).toBe(true);
      if (decoded.ok) { expect(decoded.image.width).toBe(100); expect(decoded.image.height).toBe(100); }
      const expected = Uint8Array.from(atob(defaultAvatarUrls[defaultAvatarModel(id)]['2d'].split(',')[1]!), c => c.charCodeAt(0));
      if (id === 2) expect(bytes).toEqual(expected);
      expect((await request(`/avatar/user/${id}?size=100`)).headers.get('etag')).toBe(response.headers.get('etag'));
    }
    expect(avatars[0]).not.toEqual(avatars[1]);
  });
  it('renders the configured skin including its hat layer without exposing the private hash', async () => {
    expect((await setAvatar(tid)).status).toBe(200);
    const anonymous = await request(`/avatar/user/${uid}?size=100`); expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get('cache-control')).not.toContain('immutable');
    const anonymousDecoded = await decodePng(new Uint8Array(await anonymous.arrayBuffer()));
    expect(anonymousDecoded.ok).toBe(true);
    if (anonymousDecoded.ok) expect(anonymousDecoded.image.rgba).not.toEqual(renderAvatar2d({ width: 64, height: 64, rgba }, 100).rgba);
    const response = await request(`/avatar/user/${uid}?size=100`, true); expect(response.status).toBe(200);
    expect(response.headers.get('etag')).not.toContain(hash); expect(response.headers.get('location')).toBeNull();
    const decoded = await decodePng(new Uint8Array(await response.arrayBuffer())); expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.image.rgba).toEqual(renderAvatar2d({ width: 64, height: 64, rgba }, 100).rgba);
    const lookup = await (await request(`/api/v1/users/${uid}/avatar-url`)).json<{ url: string }>(); expect(lookup.url).toContain(`/avatar/user/${uid}`); expect(lookup.url).not.toContain(hash);
  });
  it('keeps private avatar derivatives available to their owner only', async () => {
    await setAvatar(tid);
    const hidden = await request(`/avatar/user/${uid}?mode=3d&size=100`);
    expect(hidden.headers.get('cache-control')).toBe('public, max-age=60');
    const response = await request(`/avatar/user/${uid}?mode=3d&size=100`, true); expect(response.status).toBe(200);
    const decoded = await decodePng(new Uint8Array(await response.arrayBuffer())); expect(decoded.ok).toBe(true);
    if (decoded.ok) { expect(decoded.image.rgba).toEqual(renderAvatar3d({ width: 64, height: 64, rgba }, 100).rgba); expect(decoded.image.rgba).not.toEqual(renderAvatar2d({ width: 64, height: 64, rgba }, 100).rgba); }
  });
  it('restores the same default after reset and falls back when skin data is missing', async () => {
    const initial = new Uint8Array(await (await request(`/avatar/user/${uid}`, true)).arrayBuffer());
    await setAvatar(tid); await setAvatar(null);
    expect(new Uint8Array(await (await request(`/avatar/user/${uid}`, true)).arrayBuffer())).toEqual(initial);
    await setAvatar(tid); await env.BUCKET.delete(textureObjectKey(hash));
    expect(new Uint8Array(await (await request(`/avatar/user/${uid}`)).arrayBuffer())).toEqual(initial);
  });
  it('honors conditional caching and only permits valid sizes', async () => {
    await setAvatar(null);
    const response = await request(`/avatar/user/${uid}`);
    const cached = await SELF.fetch(`https://x/avatar/user/${uid}`, { headers: { 'if-none-match': response.headers.get('etag')! } }); expect(cached.status).toBe(304);
    expect((await request(`/avatar/user/${uid}?size=99999`)).status).toBe(404);
    expect((await request('/avatar/user/not-a-number')).status).toBe(404);
  });
});
