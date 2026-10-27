// 材质被改动后，各处缓存的失效规则。
//
// 一、衍生图（预览/头像）以哈希寻址、按 immutable 下发，但**预览的渲染结果还
// 取决于 kind/model**：这两列可以在材质页改，而哈希不变。改完不删产物，新模型
// 就永远看不到 —— 缓存不会自己过期，URL 也没变。规则：
//   1. 改类型/模型 → 该哈希的产物被删，下次请求按新模型重建
//   2. 预览的 ETag 必须体现 kind/model（否则重验证会拿到 304 继续用旧图）
//   3. 只有渲染签名与库内一致的 URL 才允许 immutable 缓存
//
// 二、按可变身份寻址的协议出口（`/raw/{tid}`、`/skin|/cape/{player}.png`、
// `/{player}.json`）URL 与内容不是一一对应，所以不能 immutable，只能重验证；
// 覆盖保存/删除材质时还要把穿戴者角色的 updated_at 推进 —— 否则客户端带旧 ETag
// 重验证会拿到 304，继续用随后就被删掉的旧哈希（游戏里就是皮肤加载失败）。
/// <reference types="@cloudflare/vitest-pool-workers" />

import { invalidateSettingsCache } from './../src/core/settings-reader.ts';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../../../packages/minecraft/test/png-builder.ts';
import { avatarObjectKey, previewObjectKey, textureObjectKey } from '../../../packages/minecraft/src/texture.ts';
import { DERIVATIVE_CACHE_CONTROL, REVALIDATE_CACHE_CONTROL, TEXTURE_CACHE_CONTROL } from '../../../packages/minecraft/src/csl.ts';

import { makeAdmin, runMigrations } from './setup.ts';

let seq = 0;
const PASSWORD = 'correct-horse-9';

function uniq(prefix: string): string {
  return `${prefix}_${++seq}_${Date.now().toString(36).replace(/[^a-z0-9]/g, '').slice(-6)}`;
}

async function registerUser(): Promise<{ id: number; email: string; playerName: string }> {
  const email = `${uniq('u')}@example.com`;
  const playerName = uniq('p');
  const res = await SELF.fetch('https://x/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, playerName }),
  });
  expect(res.status).toBe(201);
  const { id } = await res.json<{ id: number }>();
  return { id, email, playerName };
}

async function login(identifier: string): Promise<string> {
  const res = await SELF.fetch('https://x/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return (await res.json<{ accessToken: string }>()).accessToken;
}

async function authedFetch(cookie: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${cookie}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('sec-fetch-site', 'same-origin');
  return SELF.fetch(url, { ...init, headers });
}

/** 上传并等预生成的 preview 落地（waitUntil 里的生成不能跨过本用例的存储帧） */
async function uploadTexture(
  cookie: string, bytes: Uint8Array<ArrayBuffer>,
  opts: { kind: 'skin' | 'cape'; model?: 'default' | 'slim' },
): Promise<{ id: number; hash: string }> {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'image/png' }), 't.png');
  form.set('kind', opts.kind);
  if (opts.model) form.set('model', opts.model);
  form.set('name', uniq('tex'));
  const res = await authedFetch(cookie, 'https://x/api/v1/textures', { method: 'POST', body: form });
  expect(res.status).toBe(201);
  const body = await res.json<{ id: number; hash: string }>();
  const deadline = Date.now() + 5000;
  while (!(await env.BUCKET.head(previewObjectKey(body.hash))) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return body;
}

async function patchTexture(cookie: string, id: number, body: Record<string, unknown>): Promise<void> {
  const res = await authedFetch(cookie, `https://x/api/v1/textures/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  expect(res.status).toBe(200);
}

async function pngBytes(res: Response): Promise<Uint8Array> {
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

/** 覆盖保存：把某个纹理的内容换成另一张（哈希随之变） */
async function replaceContent(cookie: string, id: number, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'image/png' }), 't.png');
  const res = await authedFetch(cookie, `https://x/api/v1/textures/${id}/content`, { method: 'PUT', body: form });
  expect(res.status).toBe(200);
  return (await res.json<{ hash: string }>()).hash;
}

/** 取当前用户的第一个角色 id，并把某个纹理装到皮肤位 */
async function equipSkin(cookie: string, textureId: number): Promise<number> {
  return equip(cookie, { skin: textureId });
}

/** 装到披风位 */
async function equipCape(cookie: string, textureId: number): Promise<number> {
  return equip(cookie, { cape: textureId });
}

async function equip(cookie: string, body: { skin?: number; cape?: number }): Promise<number> {
  const players = await (await authedFetch(cookie, 'https://x/api/v1/players')).json<{ items: { id: number }[] }>();
  const playerId = players.items[0]!.id;
  const res = await authedFetch(cookie, `https://x/api/v1/players/${playerId}/textures`, {
    method: 'PUT', body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return playerId;
}

async function registerAdmin(): Promise<string> {
  const admin = await registerUser();
  const cookie = await login(admin.email);
  await makeAdmin(admin.id);
  return cookie;
}

/** 在 Cache API 里占位，用来验证协议出口的边缘缓存真的被清了 */
async function plantCacheEntries(name: string): Promise<string[]> {
  const origin = (env.APP_URL || 'https://x').replace(/\/$/, '');
  const urls = [
    `${origin}/${name}.json`, `${origin}/csl/${name}.json`, `${origin}/usm/${name}`,
    `${origin}/skin/${name}.png`, `${origin}/cape/${name}.png`,
  ];
  for (const url of urls) await caches.default.put(url, new Response('cached'));
  return urls;
}

async function expectCacheCleared(urls: string[]): Promise<void> {
  for (const url of urls) expect(await caches.default.match(url), url).toBeUndefined();
}

async function writeSetting(key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings(key,locale,value,updated_at) VALUES(?, '', ?, ?) ON CONFLICT(key,locale) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).bind(key, value, Date.now()).run();
  invalidateSettingsCache();
}

async function profileOf(name: string, etag?: string): Promise<{ status: number; etag: string | null; body: string }> {
  const res = await SELF.fetch(`https://x/${name}.json`, etag ? { headers: { 'if-none-match': etag } } : {});
  return { status: res.status, etag: res.headers.get('etag'), body: res.status === 304 ? '' : await res.text() };
}

beforeAll(async () => { await runMigrations(); });

describe('材质改动后的衍生图失效', () => {
  it('覆盖保存换掉 slim 布局后删除旧预览产物，并让新模型生效', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const { id, hash } = await uploadTexture(cookie, makePng({ width: 64, height: 64, slim: true }), { kind: 'skin' });

    const before = await pngBytes(await SELF.fetch(`https://x/preview/${hash}?kind=skin&model=slim`));
    expect(await env.BUCKET.head(previewObjectKey(hash))).not.toBeNull();

    // 覆盖成经典布局的新图：哈希随之变，模型被重新判定为 default
    const nextHash = await replaceContent(cookie, id, makePng({ width: 64, height: 64, seed: 3 }));

    // 旧哈希不再被引用：预览产物必须清掉
    expect(await env.BUCKET.head(previewObjectKey(hash))).toBeNull();
    const after = await SELF.fetch(`https://x/preview/${nextHash}?kind=skin&model=default`);
    const afterBytes = await pngBytes(after);
    expect(after.headers.get('cache-control')).toBe(DERIVATIVE_CACHE_CONTROL);
    expect(Buffer.from(afterBytes).equals(Buffer.from(before))).toBe(false);
    expect(await env.BUCKET.head(previewObjectKey(nextHash))).not.toBeNull();
    const detail = await authedFetch(cookie, `https://x/api/v1/textures/${id}`);
    expect(await detail.json<{ model: string }>()).toMatchObject({ model: 'default' });
  });

  it('覆盖保存同一张图时也能纠正存量错标的模型（同 hash 早退分支自愈）', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const slimBytes = makePng({ width: 64, height: 64, slim: true });
    const { id, hash } = await uploadTexture(cookie, slimBytes, { kind: 'skin' });
    // 模拟存量错标：把已经入库的 slim 行改成 default
    await env.DB.prepare('UPDATE textures SET model = ? WHERE id = ?').bind('default', id).run();

    // 用户覆盖保存同一张图（净化后 hash 不变，走早退分支）
    const sameHash = await replaceContent(cookie, id, slimBytes);
    expect(sameHash).toBe(hash);
    const detail = await authedFetch(cookie, `https://x/api/v1/textures/${id}`);
    expect(await detail.json<{ model: string }>()).toMatchObject({ model: 'slim' });
  });

  it('改类型（皮肤→披风）后删除预览与头像产物', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    // 64×32 同时是合法皮肤与合法披风（比例 2），这样才能在两条类型之间切换
    const { id, hash } = await uploadTexture(cookie, makePng({ width: 64, height: 32 }), { kind: 'skin', model: 'default' });
    const avatar = await SELF.fetch(`https://x/avatar/${hash}?mode=2d&size=100`);
    expect(avatar.status).toBe(200);
    await avatar.arrayBuffer();
    expect(await env.BUCKET.head(avatarObjectKey(hash, '2d', 100))).not.toBeNull();

    await patchTexture(cookie, id, { kind: 'cape' });

    expect(await env.BUCKET.head(previewObjectKey(hash))).toBeNull();
    expect(await env.BUCKET.head(avatarObjectKey(hash, '2d', 100))).toBeNull();
    // 披风没有头像：这条端点在类型改完之后按库内类型判定
    expect((await SELF.fetch(`https://x/avatar/${hash}?mode=2d&size=100`)).status).toBe(422);
    const capePreview = await SELF.fetch(`https://x/preview/${hash}?kind=cape`);
    expect(capePreview.headers.get('cache-control')).toBe(DERIVATIVE_CACHE_CONTROL);
    await pngBytes(capePreview);
  });

  it('预览 ETag 体现 kind/model，类型切换后旧签名重验证拿到新图', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    // 64×32 同时是合法皮肤与合法披风，可以在两条类型之间切换
    const { id, hash } = await uploadTexture(cookie, makePng({ width: 64, height: 32 }), { kind: 'skin' });

    const first = await SELF.fetch(`https://x/preview/${hash}?kind=skin&model=default`);
    const firstEtag = first.headers.get('etag')!;
    await first.arrayBuffer();
    const revalidated = await SELF.fetch(`https://x/preview/${hash}?kind=skin&model=default`, { headers: { 'if-none-match': firstEtag } });
    expect(revalidated.status).toBe(304);

    // 改成披风：渲染身份从 skin:default 变为 cape:default
    await patchTexture(cookie, id, { kind: 'cape' });

    const afterPatch = await SELF.fetch(`https://x/preview/${hash}?kind=skin&model=default`, { headers: { 'if-none-match': firstEtag } });
    expect(afterPatch.status).toBe(200);
    expect(afterPatch.headers.get('etag')).not.toBe(firstEtag);
    await afterPatch.arrayBuffer();
  });

  it('渲染签名与库内一致才 immutable，未声明或不一致只重验证', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const { hash } = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });

    const matched = await SELF.fetch(`https://x/preview/${hash}?kind=skin&model=default`);
    expect(matched.headers.get('cache-control')).toBe(DERIVATIVE_CACHE_CONTROL);
    await matched.arrayBuffer();

    // 老链接与爬虫直连不会带签名：可以缓存，但必须能过期重验证。
    // 先删掉产物，让这条请求走"未命中 → 生成"分支 —— 生成分支最容易漏改缓存指令，
    // 漏了就会以一年 immutable 把未声明的 URL 钉死。
    await env.BUCKET.delete(previewObjectKey(hash));
    const undeclared = await SELF.fetch(`https://x/preview/${hash}`);
    expect(undeclared.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    await undeclared.arrayBuffer();
    expect(await env.BUCKET.head(previewObjectKey(hash))).not.toBeNull();

    const mismatched = await SELF.fetch(`https://x/preview/${hash}?kind=skin&model=slim`);
    expect(mismatched.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    await mismatched.arrayBuffer();
  });
});

describe('按可变身份寻址的协议出口', () => {
  it('/skin/{player}.png 与 /cape/{player}.png 用重验证，换肤后带旧 ETag 能拿到新皮肤', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const first = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    await equipSkin(cookie, first.id);

    const before = await SELF.fetch(`https://x/skin/${u.playerName}.png`);
    expect(before.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    const beforeEtag = before.headers.get('etag')!;
    const beforeBytes = await pngBytes(before);

    // 换一张皮肤（URL 不变，内容变）
    const second = await uploadTexture(cookie, makePng({ width: 64, height: 32 }), { kind: 'skin', model: 'default' });
    await equipSkin(cookie, second.id);

    const after = await SELF.fetch(`https://x/skin/${u.playerName}.png`, { headers: { 'if-none-match': beforeEtag } });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(beforeEtag);
    expect(Buffer.from(await pngBytes(after)).equals(Buffer.from(beforeBytes))).toBe(false);

    // 按哈希寻址的 /usm/textures/{hash} 仍是不可变的
    const byHash = await SELF.fetch(`https://x/usm/textures/${second.hash}`);
    expect(byHash.headers.get('cache-control')).toBe(TEXTURE_CACHE_CONTROL);
    await byHash.arrayBuffer();
  });

  it('/raw/{tid} 用重验证，覆盖保存后带旧 ETag 能拿到新字节', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const { id, hash } = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    await writeSetting('allow_texture_download', 'true');
    await writeSetting('allow_anonymous_download', 'true');

    const before = await SELF.fetch(`https://x/raw/${id}`);
    expect(before.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    const beforeEtag = before.headers.get('etag')!;
    const beforeBytes = await pngBytes(before);

    const newHash = await replaceContent(cookie, id, makePng({ width: 64, height: 32 }));
    expect(newHash).not.toBe(hash);

    const after = await SELF.fetch(`https://x/raw/${id}`, { headers: { 'if-none-match': beforeEtag } });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(beforeEtag);
    expect(Buffer.from(await pngBytes(after)).equals(Buffer.from(beforeBytes))).toBe(false);
  });

  it('覆盖保存穿戴中的纹理后，角色资料的 ETag 跟着变，客户端不会沿用已删除的旧哈希', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const { id, hash: oldHash } = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    await equipSkin(cookie, id);

    const before = await profileOf(u.playerName);
    expect(before.body).toContain(oldHash);

    const newHash = await replaceContent(cookie, id, makePng({ width: 64, height: 32 }));

    const after = await profileOf(u.playerName, before.etag!);
    expect(after.status).toBe(200);
    expect(after.body).toContain(newHash);
    // 旧哈希的字节已随覆盖保存删掉，所以客户端必须换到新哈希 —— 这里确认它真的没了
    expect(await env.BUCKET.head(textureObjectKey(oldHash))).toBeNull();
  });

  it('删除穿戴中的纹理后，角色资料重验证拿到 skin:null 而不是 304', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const { id } = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    await equipSkin(cookie, id);

    const before = await profileOf(u.playerName);
    await authedFetch(cookie, `https://x/api/v1/textures/${id}`, { method: 'DELETE' });

    const after = await profileOf(u.playerName, before.etag!);
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).skins.default).toBeNull();
  });

  it('清角色协议缓存时连 /skin 与 /cape 一起清', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const planted = await plantCacheEntries(u.playerName);

    // 换肤会走 purgePlayerProfiles
    const texture = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    await equipSkin(cookie, texture.id);

    await expectCacheCleared(planted);
  });

  it('/cape/{player}.png 同样是重验证，换披风后带旧 ETag 能拿到新披风', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const first = await uploadTexture(cookie, makePng({ width: 64, height: 32, seed: 1 }), { kind: 'cape' });
    await equipCape(cookie, first.id);

    const before = await SELF.fetch(`https://x/cape/${u.playerName}.png`);
    expect(before.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    const beforeEtag = before.headers.get('etag')!;
    const beforeBytes = await pngBytes(before);

    const second = await uploadTexture(cookie, makePng({ width: 64, height: 32 }), { kind: 'cape' });
    await equipCape(cookie, second.id);

    const after = await SELF.fetch(`https://x/cape/${u.playerName}.png`, { headers: { 'if-none-match': beforeEtag } });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(beforeEtag);
    expect(Buffer.from(await pngBytes(after)).equals(Buffer.from(beforeBytes))).toBe(false);
  });

  it('覆盖保存与删除穿戴中的材质，都会清该角色的协议出口缓存', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);

    // 覆盖保存
    const replaced = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    await equipSkin(cookie, replaced.id);
    const afterReplace = await plantCacheEntries(u.playerName);
    await replaceContent(cookie, replaced.id, makePng({ width: 64, height: 32 }));
    await expectCacheCleared(afterReplace);

    // 删除
    const deleted = await uploadTexture(cookie, makePng({ width: 64, height: 32, seed: 1 }), { kind: 'skin', model: 'default' });
    await equipSkin(cookie, deleted.id);
    const afterDelete = await plantCacheEntries(u.playerName);
    expect((await authedFetch(cookie, `https://x/api/v1/textures/${deleted.id}`, { method: 'DELETE' })).status).toBe(204);
    await expectCacheCleared(afterDelete);
  });

  it('改类型后，穿戴该材质的角色协议出口缓存也会被清', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    // 64×32 可在皮肤与披风之间切换，用来验证类型变更的失效路径
    const { id } = await uploadTexture(cookie, makePng({ width: 64, height: 32 }), { kind: 'skin' });
    await equipSkin(cookie, id);
    const planted = await plantCacheEntries(u.playerName);

    // 类型变了会连带改角色资料的 skins 键，批内推进指纹、这里清边缘缓存
    await patchTexture(cookie, id, { kind: 'cape' });

    await expectCacheCleared(planted);
  });

  it('后台删除穿戴中的材质后，角色资料重验证拿到 skin:null 而不是 304', async () => {
    const owner = await registerUser();
    const ownerCookie = await login(owner.email);
    const { id } = await uploadTexture(ownerCookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    await equipSkin(ownerCookie, id);
    const before = await profileOf(owner.playerName);

    const adminCookie = await registerAdmin();
    expect((await authedFetch(adminCookie, `https://x/api/v1/admin/textures/${id}`, { method: 'DELETE' })).status).toBe(204);

    const after = await profileOf(owner.playerName, before.etag!);
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).skins.default).toBeNull();
  });

  it('举报处置为删除材质时，穿戴该材质的角色资料同样失效', async () => {
    const owner = await registerUser();
    const ownerCookie = await login(owner.email);
    const { id: textureId } = await uploadTexture(ownerCookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    await equipSkin(ownerCookie, textureId);
    const before = await profileOf(owner.playerName);

    const reporter = await registerUser();
    const reporterCookie = await login(reporter.email);
    const submitted = await authedFetch(reporterCookie, 'https://x/api/v1/reports', {
      method: 'POST', body: JSON.stringify({ textureId, reason: '审核删除路径' }),
    });
    expect(submitted.status).toBe(201);

    const adminCookie = await registerAdmin();
    const pending = await (await authedFetch(adminCookie, 'https://x/api/v1/reports/admin?status=pending')).json<{ items: Array<{ id: number; textureId?: number }> }>();
    const report = pending.items.find(item => item.textureId === undefined || item.textureId === textureId) ?? pending.items[0]!;
    const resolved = await authedFetch(adminCookie, `https://x/api/v1/reports/${report.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ action: 'delete' }),
    });
    expect(resolved.status).toBe(200);

    const after = await profileOf(owner.playerName, before.etag!);
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).skins.default).toBeNull();
  });
});

describe('yggdrasil 会话服务 GET 的缓存指令', () => {
  it('资料/查找/元数据/公钥都是短窗口 + 重验证；hasJoined 完全不缓存', async () => {
    const u = await registerUser();

    const lookup = await SELF.fetch(`https://x/api/yggdrasil/api/users/profiles/minecraft/${u.playerName}`);
    expect(lookup.status).toBe(200);
    expect(lookup.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    const profileId = (await lookup.json<{ id: string }>()).id;

    // 两条 lookup 别名转发到同一 handler，头随响应一起继承
    for (const prefix of ['minecraftservices/minecraft/profile/lookup', 'api/minecraft/profile/lookup']) {
      const alias = await SELF.fetch(`https://x/api/yggdrasil/${prefix}/name/${u.playerName}`);
      expect(alias.status, prefix).toBe(200);
      expect(alias.headers.get('cache-control'), prefix).toBe(REVALIDATE_CACHE_CONTROL);
      await alias.arrayBuffer();
    }

    // 负结果（查无此人）不能进缓存：否则刚注册的角色会被判成不存在一分钟
    const missing = await SELF.fetch('https://x/api/yggdrasil/api/users/profiles/minecraft/nobody_here_404');
    expect(missing.status).toBe(204);
    expect(missing.headers.get('cache-control')).toBe('no-store');

    // 资料里带的就是皮肤/披风哈希：换肤后必须能重验证拿到新值
    const profile = await SELF.fetch(`https://x/api/yggdrasil/sessionserver/session/minecraft/profile/${profileId}`);
    expect(profile.status).toBe(200);
    expect(profile.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    await profile.arrayBuffer();

    const metadata = await SELF.fetch('https://x/api/yggdrasil/');
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    await metadata.arrayBuffer();

    // 公钥会随管理员轮换而变，不能长期缓存旧公钥
    const keys = await SELF.fetch('https://x/api/yggdrasil/minecraftservices/publickeys');
    expect(keys.status).toBe(200);
    expect(keys.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    await keys.arrayBuffer();

    // 缓存指令按端点给：即使没有 join 会话（204），票据也不允许进缓存
    const hasJoined = await SELF.fetch('https://x/api/yggdrasil/sessionserver/session/minecraft/hasJoined?username=someone&serverId=srv');
    expect(hasJoined.headers.get('cache-control')).toBe('no-store');
  });
});
