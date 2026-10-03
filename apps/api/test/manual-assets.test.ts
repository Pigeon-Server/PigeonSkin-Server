import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeAdmin, runMigrations } from './setup.ts';
import { makePng } from '../../../packages/minecraft/test/png-builder.ts';
import type { ManualAsset } from '@pigeon-skin/shared/manual';
beforeAll(runMigrations);
async function account(admin: boolean) {
  const email = `manual-assets-${crypto.randomUUID()}@example.com`, password = 'manual-assets-password';
  const response = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, playerName: 'A' + crypto.randomUUID().replaceAll('-', '').slice(0, 10) }) });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: number }>();
  if (admin) await makeAdmin(id);
  const logged = await SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
  return logged.headers.get('set-cookie')!.split(';')[0]!;
}
function upload(cookie: string, bytes: Uint8Array, name = '操作截图.png') {
  const body = new FormData();
  body.set('file', new File([bytes], name, { type: 'application/octet-stream' }));
  return SELF.fetch('https://x/api/v1/admin/manual/assets', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' }, body });
}
describe('手册资源', () => {
  it('阻止删除仅被日语文档引用的素材', async () => {
    const cookie = await account(true);
    const uploaded = await upload(cookie, makePng({ width: 64, height: 32 }));
    const asset = await uploaded.json<ManualAsset>();
    const slug = `japanese-asset-${Date.now()}`;
    const saved = await SELF.fetch(`https://x/api/v1/admin/manual/${slug}?locale=ja_JP`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ title: '日本語の説明', description: '', content: `![画像](${asset.url})`, revision: 0 }) });
    expect(saved.status).toBe(200);
    const removed = await SELF.fetch(`https://x/api/v1/admin/manual/assets/${asset.id}`, { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({ error: 'manual.asset_in_use' });
  });
  it('管理员上传，相同文件自动复用，公开图片可直接读取', async () => {
    const cookie = await account(true);
    const bytes = makePng({ width: 64, height: 64 });
    const uploaded = await upload(cookie, bytes);
    expect(uploaded.status).toBe(201);
    const asset = await uploaded.json<ManualAsset>();
    expect(asset.kind).toBe('image'); expect(asset.mime).toBe('image/png');
    const duplicate = await (await upload(cookie, bytes, '另一张截图.png')).json<ManualAsset>();
    expect(duplicate.id).toBe(asset.id);
    const response = await SELF.fetch('https://x' + asset.url);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const list = await (await SELF.fetch('https://x/api/v1/admin/manual/assets', { headers: { cookie } })).json<{ items: ManualAsset[] }>();
    expect(list.items.filter(item => item.id === asset.id)).toHaveLength(1);
  });
  it('拒绝匿名、普通用户、伪装图片和路径穿越', async () => {
    const bytes = makePng({ width: 64, height: 64 });
    expect((await upload('', bytes)).status).toBe(401);
    const user = await account(false);
    expect((await upload(user, bytes)).status).toBe(403);
    const admin = await account(true);
    expect((await upload(admin, new TextEncoder().encode('<script>alert(1)</script>'), 'fake.png')).status).toBe(422);
    expect((await SELF.fetch('https://x/api/v1/manual/assets/not-an-asset')).status).toBe(404);
  });
  it('为音频和视频提供 Range 读取，保护文档引用中的资源', async () => {
    const cookie = await account(true);
    const wav = new Uint8Array(100);
    wav.set(new TextEncoder().encode('RIFF'), 0); wav.set(new TextEncoder().encode('WAVE'), 8);
    const uploaded = await upload(cookie, wav, '提示音.wav');
    expect(uploaded.status).toBe(201);
    const asset = await uploaded.json<ManualAsset>(); expect(asset.kind).toBe('audio');
    const range = await SELF.fetch('https://x' + asset.url, { headers: { range: 'bytes=8-11' } });
    expect(range.status).toBe(206); expect(range.headers.get('content-range')).toBe('bytes 8-11/100'); expect(await range.text()).toBe('WAVE');
    expect((await SELF.fetch('https://x' + asset.url, { headers: { range: 'bytes=100-200' } })).status).toBe(416);
    const mp4 = new Uint8Array(32); mp4.set(new TextEncoder().encode('ftyp'), 4);
    const video = await (await upload(cookie, mp4, '接入指南.mp4')).json<ManualAsset>(); expect(video.kind).toBe('video');
    const videoRange = await SELF.fetch('https://x' + video.url, { headers: { range: 'bytes=0-7' } });
    expect(videoRange.status).toBe(206); await videoRange.arrayBuffer();
    const document = await SELF.fetch('https://x/api/v1/admin/manual/asset-guide', { method: 'PUT', headers: { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ title: '接入指南', description: '', content: `<audio controls src="${asset.url}"></audio>`, revision: 0 }) });
    expect(document.status).toBe(200);
    const saved = await document.json<{ updatedAt: number }>();
    expect((await SELF.fetch('https://x/api/v1/admin/manual/assets/' + asset.id, { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(409);
    await SELF.fetch(`https://x/api/v1/admin/manual/asset-guide?revision=${saved.updatedAt}`, { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect((await SELF.fetch('https://x/api/v1/admin/manual/assets/' + asset.id, { method: 'DELETE', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(204);
    expect((await SELF.fetch('https://x' + asset.url)).status).toBe(404);
  });
});
