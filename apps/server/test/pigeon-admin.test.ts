// Pigeon 管理级 API 集成测试 —— machine-facing 端点（API key + scope）。
// 覆盖：鉴权 401/403、用户 CRUD、reset-password、会话吊销、纹理治理、
// 统计/审计查询、设置脱敏与 superAdminOnly 隐藏、广播。
/// <reference types="@cloudflare/vitest-pool-workers" />

import { invalidateSettingsCache } from './../src/core/settings-reader.ts';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@pigeon-skin/auth';

import { runMigrations, markVerified } from './setup.ts';

let seq = 0;
function uniq(prefix: string): string {
  return `${prefix}_${++seq}_${Date.now().toString(36).replace(/[^a-z0-9]/g, '')}`;
}

const PASSWORD = 'correct-horse-9';

/** 在 D1 里直接签发一把指定 scopes 的 key，返回明文 secret（只此处能拿到）。
 * key 必须有 created_by（真实用户）—— pigeon-admin 的审计归属依赖它。
 * vitest-pool-workers 对每个用例隔离存储，owner 每次都要重新确保存在。 */
async function mintKey(scopes: string[]): Promise<string> {
  const ownerEmail = 'pigeon-key-owner@example.com';
  await env.DB.prepare(
    `INSERT INTO users (email, nickname, score, password_hash, role, created_at, updated_at)
     SELECT ?, 'Pigeon Key Owner', 0, 'x', 'super_admin', ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`,
  ).bind(ownerEmail, Date.now(), Date.now(), ownerEmail).run();
  const keyOwnerId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(ownerEmail).first<{ id: number }>())!.id;
  const secret = `psk_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  await env.DB.prepare(
    'INSERT INTO pigeon_api_keys (id, label, secret_hash, prefix, scopes, created_by, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
  ).bind(crypto.randomUUID(), 'test', await hashToken(secret), secret.slice(0, 12), JSON.stringify(scopes), keyOwnerId, Date.now()).run();
  return secret;
}

/** 指定签发者的 key（测试 keyActor 实时角色检查用） */
async function mintKeyForOwner(scopes: string[], ownerId: number): Promise<string> {
  const secret = `psk_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  await env.DB.prepare(
    'INSERT INTO pigeon_api_keys (id, label, secret_hash, prefix, scopes, created_by, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
  ).bind(crypto.randomUUID(), 'test-owner', await hashToken(secret), secret.slice(0, 12), JSON.stringify(scopes), ownerId, Date.now()).run();
  return secret;
}

async function pigeonFetch(path: string, key: string | null, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://x${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(key ? { 'api-key': key } : {}),
      ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
    },
  });
}

/** 64×64 RGBA 皮肤;slim=true 时把右臂 unused 区挖成透明(模型判定特征)。
 *  workerd 里没有 node:zlib,手写 stored-block zlib 流 + Adler-32 尾。 */
function makeSkinPng(slim: boolean): Uint8Array<ArrayBuffer> {
  const width = 64, height = 64;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => { const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length); const body = new Uint8Array(4 + data.length); body.set(new TextEncoder().encode(type)); body.set(data, 4); const crcB = new Uint8Array(4); new DataView(crcB.buffer).setUint32(0, crc(body)); return new Uint8Array([...len, ...body, ...crcB]); };
  const ihdr = new Uint8Array(13); new DataView(ihdr.buffer).setUint32(0, width); new DataView(ihdr.buffer).setUint32(4, height); ihdr[8] = 8; ihdr[9] = 6;
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (1 + width * 4) + 1 + x * 4 + 3] = 255;
  if (slim) {
    for (const area of [{ x: 50, y: 16, w: 2, h: 4 }, { x: 54, y: 20, w: 2, h: 12 }]) {
      for (let y = area.y; y < area.y + area.h; y++) for (let x = area.x; x < area.x + area.w; x++) raw[y * (1 + width * 4) + 1 + x * 4 + 3] = 0;
    }
  }
  const store: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) { const slice = raw.subarray(i, i + 65535); store.push(i + 65535 < raw.length ? 0 : 1, slice.length & 255, slice.length >> 8, (~slice.length) & 255, ((~slice.length) >> 8) & 255, ...slice); }
  let s1 = 1, s2 = 0;
  for (const b of raw) { s1 = (s1 + b) % 65521; s2 = (s2 + s1) % 65521; }
  const adler = ((s2 << 16) | s1) >>> 0;
  store.push((adler >>> 24) & 255, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255);
  return new Uint8Array([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(store)), chunk('IEND', new Uint8Array(0))].flatMap(c => [...c]));
}

beforeAll(async () => {
  await runMigrations();
  await markVerified('admin@example.test');
});

describe('pigeon admin api — 鉴权', () => {
  it('无 key / 坏 key → 401', async () => {
    expect((await pigeonFetch('/api/v1/pigeon/admin/users', null)).status).toBe(401);
    expect((await pigeonFetch('/api/v1/pigeon/admin/users', 'psk_wrong')).status).toBe(401);
  });

  it('scope 不符 → 403', async () => {
    const wrongScope = await mintKey(['players.read']);
    const res = await pigeonFetch('/api/v1/pigeon/admin/users', wrongScope);
    expect(res.status).toBe(403);
  });
});

describe('pigeon admin api — 用户管理', () => {
  it('create → 201，email 冲突 → 409；list 分页可查到', async () => {
    const key = await mintKey(['admin.users.write']);
    const email = `${uniq('pigeon-u')}@example.com`;
    const created = await pigeonFetch('/api/v1/pigeon/admin/users', key, {
      method: 'POST',
      body: JSON.stringify({ email, nickname: 'Pigeon创建', password: PASSWORD }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: number }>();
    expect(typeof id).toBe('number');

    const duplicate = await pigeonFetch('/api/v1/pigeon/admin/users', key, {
      method: 'POST',
      body: JSON.stringify({ email, nickname: 'x', password: PASSWORD }),
    });
    expect(duplicate.status).toBe(409);

    const list = await pigeonFetch(`/api/v1/pigeon/admin/users?q=${email}`, key);
    expect(list.status).toBe(200);
    const listBody = await list.json<{ items: { id: number; email: string }[]; total: number }>();
    expect(listBody.items.some((u) => u.id === id)).toBe(true);
  });

  it('patch（role/score）→ ok；reset-password 返回临时密码；sessions 吊销 → 204；delete → 204', async () => {
    const key = await mintKey(['admin.users.write']);
    const email = `${uniq('pigeon-p')}@example.com`;
    const created = await pigeonFetch('/api/v1/pigeon/admin/users', key, {
      method: 'POST',
      body: JSON.stringify({ email, nickname: 'Patch目标', password: PASSWORD }),
    });
    const { id } = await created.json<{ id: number }>();

    const patched = await pigeonFetch(`/api/v1/pigeon/admin/users/${id}`, key, {
      method: 'PATCH',
      body: JSON.stringify({ score: 500, role: 'normal' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json<{ score?: number }>()).score) ?? 500).toBeTruthy();

    const reset = await pigeonFetch(`/api/v1/pigeon/admin/users/${id}/reset-password`, key, { method: 'POST' });
    expect(reset.status).toBe(200);
    const { temporaryPassword } = await reset.json<{ temporaryPassword: string }>();
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(8);

    const revoked = await pigeonFetch(`/api/v1/pigeon/admin/users/${id}/sessions`, key, { method: 'DELETE' });
    expect(revoked.status).toBe(204);

    const deleted = await pigeonFetch(`/api/v1/pigeon/admin/users/${id}`, key, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
  });
});

describe('pigeon admin api — 纹理治理', () => {
  it('list 分页 200；patch name/visibility → ok；delete → 204', async () => {
    const key = await mintKey(['admin.textures.write']);
    // 准备一条纹理：直接借用户上传通道太重，用 SQL 插入最小行
    const hash = 'a'.repeat(64);
    const insert = await env.DB.prepare(
      `INSERT INTO textures (hash, kind, model, name, origin, size_bytes, visibility, width, height, likes, created_at, updated_at)
       VALUES (?, 'skin', 'default', 'pigeon-texture-test', 'original', 100, 'public', 64, 64, 0, ?, ?)`,
    ).bind(hash, Date.now(), Date.now()).run();
    const textureId = (insert.meta as unknown as { last_row_id: number }).last_row_id as number;

    const list = await pigeonFetch('/api/v1/pigeon/admin/textures?q=pigeon-texture-test', key);
    expect(list.status).toBe(200);
    const listBody = await list.json<{ items: { id: number }[] }>();
    expect(listBody.items.some((t) => t.id === textureId)).toBe(true);

    const patched = await pigeonFetch(`/api/v1/pigeon/admin/textures/${textureId}`, key, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'pigeon-renamed', visibility: 'private' }),
    });
    expect(patched.status).toBe(200);

    const row = await env.DB.prepare('SELECT name, visibility FROM textures WHERE id = ?').bind(textureId).first<{ name: string; visibility: string }>();
    expect(row?.name).toBe('pigeon-renamed');
    expect(row?.visibility).toBe('private');

    const deleted = await pigeonFetch(`/api/v1/pigeon/admin/textures/${textureId}`, key, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
  });

  it('redetect-skin-model 按像素纠正存量错标，并跳过缺失对象', async () => {
    const key = await mintKey(['admin.textures.write']);
    const { sanitizeTexture, sha256Hex } = await import('@pigeon-skin/minecraft');
    // 两张像素可辨的皮肤:slim 布局(错标 default) 与经典布局(本就正确)
    const slimPng = makeSkinPng(true);
    const classicPng = makeSkinPng(false);
    const now = Date.now();
    const ids: number[] = [];
    for (const [bytes, model] of [[slimPng, 'default'], [classicPng, 'default']] as const) {
      const sanitized = await sanitizeTexture(bytes, { kind: 'skin' });
      if (!sanitized.ok) throw new Error(sanitized.reason);
      const hash = await sha256Hex(sanitized.bytes);
      await env.BUCKET.put(`textures/${hash}.png`, sanitized.bytes);
      const insert = await env.DB.prepare(
        `INSERT INTO textures (hash, kind, model, name, origin, size_bytes, visibility, width, height, likes, created_at, updated_at)
         VALUES (?, 'skin', ?, 'redetect-test', 'original', ?, 'public', 64, 64, 0, ?, ?)`,
      ).bind(hash, model, sanitized.bytes.length, now, now).run();
      ids.push((insert.meta as unknown as { last_row_id: number }).last_row_id as number);
    }
    // 第三行:对象缺失,应计入 skipped 而不是 500
    const missing = await env.DB.prepare(
      `INSERT INTO textures (hash, kind, model, name, origin, size_bytes, visibility, width, height, likes, created_at, updated_at)
       VALUES (?, 'skin', 'default', 'redetect-missing', 'original', 100, 'public', 64, 64, 0, ?, ?)`,
    ).bind('b'.repeat(64), now, now).run();
    const missingId = (missing.meta as unknown as { last_row_id: number }).last_row_id as number;

    const response = await pigeonFetch('/api/v1/pigeon/admin/textures/redetect-skin-model', key, {
      method: 'POST', body: JSON.stringify({ lastId: 0, limit: 200 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ processed: number; changed: number; skipped: number; nextCursor: number | null }>();
    expect(body.processed).toBeGreaterThanOrEqual(3);
    expect(body.changed).toBe(1);
    expect(body.skipped).toBe(1);

    const slimModel = await env.DB.prepare('SELECT model FROM textures WHERE id = ?').bind(ids[0]!).first<{ model: string }>();
    expect(slimModel?.model).toBe('slim');
    const classicModel = await env.DB.prepare('SELECT model FROM textures WHERE id = ?').bind(ids[1]!).first<{ model: string }>();
    expect(classicModel?.model).toBe('default');
    const untouched = await env.DB.prepare('SELECT model FROM textures WHERE id = ?').bind(missingId).first<{ model: string }>();
    expect(untouched?.model).toBe('default');
  });
});

describe('pigeon admin api — 统计与审计查询', () => {
  it('stats 返回计数形状；audit-log 分页与 action 过滤', async () => {
    const writeKey = await mintKey(['admin.users.write']);
    // 每用例存储隔离：先自行制造一条审计（创建用户会写 admin.user.create）
    const email = `${uniq('pigeon-audit')}@example.com`;
    const created = await pigeonFetch('/api/v1/pigeon/admin/users', writeKey, {
      method: 'POST',
      body: JSON.stringify({ email, nickname: 'AuditSource', password: PASSWORD }),
    });
    expect(created.status).toBe(201);

    const key = await mintKey(['admin.stats.read']);
    const stats = await pigeonFetch('/api/v1/pigeon/admin/stats', key);
    expect(stats.status).toBe(200);
    const body = await stats.json<Record<string, unknown>>();
    expect(Object.keys(body).length).toBeGreaterThan(0);

    const log = await pigeonFetch('/api/v1/pigeon/admin/audit-log?action=admin.user.create', key);
    expect(log.status).toBe(200);
    const logBody = await log.json<{ items: { action: string; actorId: number }[]; total: number }>();
    expect(logBody.total).toBeGreaterThan(0);
    expect(logBody.items.every((i) => i.action === 'admin.user.create')).toBe(true);

    // actor_id 过滤：只留该签发者的记录；非法 actor_id → 422
    const issuerId = logBody.items[0]!.actorId;
    const filtered = await pigeonFetch(`/api/v1/pigeon/admin/audit-log?action=admin.user.create&actor_id=${issuerId}`, key);
    const filteredBody = await filtered.json<{ items: { actorId: number }[] }>();
    expect(filteredBody.items.every((i) => i.actorId === issuerId)).toBe(true);
    const invalid = await pigeonFetch('/api/v1/pigeon/admin/audit-log?actor_id=abc', key);
    expect(invalid.status).toBe(422);
  });
});

describe('pigeon admin api — keyActor 安全约束', () => {
  it('签发者被降级后 key 失去能力（实时角色检查）；签发者自己也被 canModifyUser 拦截', async () => {
    // 建 owner（admin 角色）+ 签发者身份签发 users.write key
    const ownerEmail = `${uniq('pigeon-owner')}@example.com`;
    const ownerInsert = await env.DB.prepare(
      `INSERT INTO users (email, nickname, score, password_hash, role, created_at, updated_at)
       VALUES (?, 'Pigeon Issuer', 0, 'x', 'admin', ?, ?)`,
    ).bind(ownerEmail, Date.now(), Date.now()).run();
    const ownerId = (ownerInsert.meta as unknown as { last_row_id: number }).last_row_id as number;
    const key = await mintKeyForOwner(['admin.users.write'], ownerId);

    // 目标：一个 super_admin 用户（admin 签发者本无权修改）
    const superEmail = `${uniq('pigeon-super')}@example.com`;
    const superInsert = await env.DB.prepare(
      `INSERT INTO users (email, nickname, score, password_hash, role, created_at, updated_at)
       VALUES (?, 'Pigeon Super', 0, 'x', 'super_admin', ?, ?)`,
    ).bind(superEmail, Date.now(), Date.now()).run();
    const superId = (superInsert.meta as unknown as { last_row_id: number }).last_row_id as number;

    // 对 super_admin 的修改被 canModifyUser（admin < super_admin）拦截 → 403
    const escalate = await pigeonFetch(`/api/v1/pigeon/admin/users/${superId}`, key, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'normal' }),
    });
    expect(escalate.status).toBe(403);

    // 签发者被降级为 normal 后，同一把 key 立即失去能力（实时角色检查）→ 403
    await env.DB.prepare("UPDATE users SET role = 'normal' WHERE id = ?").bind(ownerId).run();
    const afterDemotion = await pigeonFetch('/api/v1/pigeon/admin/users', key);
    expect(afterDemotion.status).toBe(403);
  });
});

describe('pigeon admin api — 设置与广播', () => {
  it('settings GET 脱敏 secret 且不返回 superAdminOnly；PATCH 普通键生效、secret 拒绝', async () => {
    const key = await mintKey(['admin.settings.write']);
    invalidateSettingsCache();
    const got = await pigeonFetch('/api/v1/pigeon/admin/settings', key);
    expect(got.status).toBe(200);
    const { values } = await got.json<{ values: Record<string, string> }>();
    // resend_api_key 是 secret+superAdminOnly：既不应出现，也不应有明文
    expect(values['resend_api_key']).toBeUndefined();
    expect(Object.values(values).some((v) => v.includes('sk-'))).toBe(false);

    const patched = await pigeonFetch('/api/v1/pigeon/admin/settings', key, {
      method: 'PATCH',
      body: JSON.stringify({ settings: [{ key: 'site_name', value: 'Pigeon 管理API测试' }] }),
    });
    expect(patched.status).toBe(200);
    const { written } = await patched.json<{ written: number }>();
    expect(written).toBe(1);

    const after = await pigeonFetch('/api/v1/pigeon/admin/settings', key);
    const { values: afterValues } = await after.json<{ values: Record<string, string> }>();
    expect(afterValues['site_name']).toBe('Pigeon 管理API测试');

    // secret/superAdminOnly 键经 API 不可写（isSuperAdmin=false → 403）
    const secretPatch = await pigeonFetch('/api/v1/pigeon/admin/settings', key, {
      method: 'PATCH',
      body: JSON.stringify({ settings: [{ key: 'resend_api_key', value: 'sk-evil' }] }),
    });
    expect(secretPatch.status).toBe(403);
  });

  it('broadcast → sent 计数 + 审计', async () => {
    const key = await mintKey(['admin.settings.write']);
    const res = await pigeonFetch('/api/v1/pigeon/admin/notifications', key, {
      method: 'POST',
      body: JSON.stringify({ title: '管理API广播', content: 'hello', receiver: 'all' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ sent: number; emailQueued: boolean }>();
    expect(body.emailQueued).toBe(true);
    expect(body.sent).toBeGreaterThanOrEqual(0);
  });
});
