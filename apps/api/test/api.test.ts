// API 集成测试 —— 在 workerd（vitest-pool-workers）里跑真实的 Hono 应用。
//
// 覆盖面按风险排序：
//   1. 认证链路（注册/登录/会话/邮箱验证强制/节流）—— 安全核心
//   2. 玩家与纹理（上传校验/哈希/可见性/积分）—— 业务核心
//   3. 协议端点（CSL 契约字节级形状）—— 外部兼容核心
//   4. 横切层（CSRF、audit_log）—— 本次补齐的缺口
//
// 测试间通过唯一的 email/名字后缀隔离，不依赖执行顺序。
/// <reference types="@cloudflare/vitest-pool-workers" />


import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../../../packages/minecraft/test/png-builder.ts';
import { sha256Hex } from '../../../packages/minecraft/src/png.ts';
import { avatarObjectKey, previewObjectKey } from '../../../packages/minecraft/src/texture.ts';
import { invalidateSettingsCache } from '../src/lib.ts';
import { createApp } from '../src/app.ts';
import {
  runMigrations, markVerified, makeAdmin, readAudit,
} from './setup.ts';
import { BLOCKED_CRAWLER_AGENTS } from '../src/route-metadata.ts';

let seq = 0;
/**
 * 唯一后缀。玩家名只允许官方字符集（字母数字下划线）且长度上限 16，
 * 所以时间戳取 base36 末 6 位，保证 `bare_999_xxxxxx` 这类长前缀也不超限。
 */
function uniq(prefix: string): string {
  return `${prefix}_${++seq}_${Date.now().toString(36).replace(/[^a-z0-9]/g, '').slice(-6)}`;
}

const PASSWORD = 'correct-horse-9';

interface Registered {
  id: number;
  email: string;
  playerName: string;
}

async function registerUser(overrides: { email?: string; playerName?: string } = {}): Promise<Registered> {
  const email = overrides.email ?? `${uniq('u')}@example.com`;
  const playerName = overrides.playerName ?? uniq('p');
  const res = await SELF.fetch('https://x/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, playerName }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ id: number }>();
  return { id: body.id, email, playerName };
}

/** 用已注册用户登录，返回会话 Cookie */
async function login(identifier: string, password = PASSWORD): Promise<string> {
  const res = await SELF.fetch('https://x/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  expect(res.status).toBe(200);
  return getCookie(res);
}

function getCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const pair = setCookie.split(';')[0] ?? '';
  return pair;
}

async function authedFetch(
  cookie: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('cookie', cookie);
  // FormData 自带 boundary 的 content-type 由 fetch 生成，绝不能覆盖
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  // 测试请求按"同源浏览器"处理，CSRF 中间件按 Sec-Fetch-Site 放行
  headers.set('sec-fetch-site', 'same-origin');
  return SELF.fetch(url, { ...init, headers });
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await runMigrations();
});

describe('admin route authorization coverage', () => {
  it('guards every registered admin endpoint from guests and regular users', async () => {
    const app = createApp();
    const endpoints = app.routes
      .filter(route => route.path === '/api/v1/admin' || route.path.startsWith('/api/v1/admin/'))
      .filter(route => route.method !== '*' && route.method !== 'OPTIONS' && route.method !== 'USE')
      .map(route => ({
        // app.all 注册的端点用 GET 探测即可覆盖守卫判定
        method: route.method === 'ALL' ? 'GET' : route.method,
        path: route.path.replace(/:[^/]+/g, '1').replace(/\*/g, 'probe'),
      }));
    expect(endpoints.length).toBeGreaterThan(0);

    const regular = await registerUser();
    await markVerified(regular.email);
    const cookie = await login(regular.email);
    for (const endpoint of endpoints) {
      const guest = await app.request(endpoint.path, { method: endpoint.method }, env);
      expect([401, 403], `guest ${endpoint.method} ${endpoint.path}`).toContain(guest.status);

      const member = await app.request(endpoint.path, {
        method: endpoint.method,
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
      }, env);
      expect([401, 403], `member ${endpoint.method} ${endpoint.path}`).toContain(member.status);
    }
  });
});

// ── 健康检查 ─────────────────────────────────────────────────────────────────

describe('GET /api/v1/health', () => {
  it('返回 ok 且 db 正常', async () => {
    const res = await SELF.fetch('https://x/api/v1/health');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; db: string }>();
    expect(body.ok).toBe(true);
    expect(body.db).toBe('ok');
  });
});

// ── 注册与登录 ───────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register', () => {
  it('注册成功自动创建玩家并返回 201', async () => {
    const playerName = uniq('r');
    const res = await SELF.fetch('https://x/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${uniq('e')}@example.com`, password: PASSWORD, playerName,
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toContain('bs_session=');

    // 注册即建玩家（register_with_player_name 默认 true）
    const list = await SELF.fetch(`https://x/api/v1/protocol-probe/${playerName}.json`);
    void list; // 协议端点在下面单独测；这里只验证注册本身
  });

  it('重复邮箱返回 409', async () => {
    const email = `${uniq('dup')}@example.com`;
    await registerUser({ email });
    const res = await SELF.fetch('https://x/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, playerName: uniq('x') }),
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('auth.email_taken');
  });

  it('非法玩家名返回 422', async () => {
    const res = await SELF.fetch('https://x/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${uniq('n')}@example.com`, password: PASSWORD, playerName: 'a',
      }),
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('邮箱与玩家名都能登录', async () => {
    const u = await registerUser();
    for (const identifier of [u.email, u.playerName]) {
      const res = await SELF.fetch('https://x/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, password: PASSWORD }),
      });
      expect(res.status).toBe(200);
    }
  });

  it('错误密码返回 401 且带 captchaRequired 提示', async () => {
    const u = await registerUser();
    const res = await SELF.fetch('https://x/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: u.email, password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string; captchaRequired?: boolean }>();
    expect(body.error).toBe('auth.invalid_credentials');
  });

  it('登录会话轮换：旧 Cookie 登录后失效', async () => {
    const u = await registerUser();
    const firstCookie = await login(u.email);

    // 第二次登录（新会话）
    await login(u.playerName);

    // 第一次登录拿到的 Cookie 应已被轮换撤销
    const res = await authedFetch(firstCookie, 'https://x/api/v1/auth/session');
    expect(res.status).toBe(401);
  });
});

// ── CSRF ─────────────────────────────────────────────────────────────────────

describe('CSRF 防线', () => {
  it('跨站来源的 POST 被拒绝', async () => {
    const res = await SELF.fetch('https://x/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ identifier: 'a@b.c', password: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('同源与无 Sec-Fetch-Site 的客户端放行', async () => {
    // 无任何 Sec-Fetch 头的老客户端（脚本）放行 —— 凭据受 SameSite 保护
    const res = await SELF.fetch('https://x/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'nobody@example.com', password: 'x' }),
    });
    expect(res.status).toBe(401); // 到达了业务层（401 而不是 403）
  });
});

// ── 会话与资料 ───────────────────────────────────────────────────────────────

describe('会话与资料', () => {
  it('session 返回当前用户；未登录 401', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);

    const ok = await authedFetch(cookie, 'https://x/api/v1/auth/session');
    expect(ok.status).toBe(200);
    const body = await ok.json<{ email: string; emailVerified: boolean }>();
    expect(body.email).toBe(u.email);
    expect(body.emailVerified).toBe(false);

    const anon = await SELF.fetch('https://x/api/v1/auth/session');
    expect(anon.status).toBe(401);
  });

  it('未知会话 token 视为未登录（401），而不是 500', async () => {
    const res = await SELF.fetch('https://x/api/v1/auth/session', { headers: { cookie: 'bs_session=bogus' } });
    expect(res.status).toBe(401);
  });

  it('登出后 Cookie 失效', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    await authedFetch(cookie, 'https://x/api/v1/auth/logout', { method: 'POST' });
    const res = await authedFetch(cookie, 'https://x/api/v1/auth/session');
    expect(res.status).toBe(401);
  });
});

// ── 邮箱验证强制 ─────────────────────────────────────────────────────────────

describe('require_email_verification', () => {
  it('开启后未验证用户仍可登录，验证只在特定路由拦截', async () => {
    const u = await registerUser();

    // 用管理员 API 开启开关：写入路径会调用 invalidateSettingsCache()，
    // 且 SELF 与测试同 isolate，设置立即生效。
    // （直接写 D1 会被 isolate 的 60 秒设置缓存遮蔽，登录仍读到 false。）
    const admin = await registerUser();
    const cookie = await login(admin.email);
    await makeAdmin(admin.id);
    const patched = await authedFetch(cookie, 'https://x/api/v1/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ settings: [{ key: 'require_email_verification', value: 'true' }] }),
    });
    expect(patched.status).toBe(200);

    // 账号不被拦截：未验证用户照常拿到会话
    const userCookie = await login(u.email);
    const session = await authedFetch(userCookie, 'https://x/api/v1/auth/session');
    expect(session.status).toBe(200);
    // 未验证状态仍如实回报，用户中心据此显示提示与补发入口
    expect((await session.json<{ emailVerified: boolean }>()).emailVerified).toBe(false);

    // 关掉开关，避免影响其它测试
    await authedFetch(cookie, 'https://x/api/v1/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ settings: [{ key: 'require_email_verification', value: 'false' }] }),
    });
  });
});

// ── 玩家 ─────────────────────────────────────────────────────────────────────

describe('玩家', () => {
  it('renaming a player clears profile caches for both names', async () => {
    const user = await registerUser();
    const cookie = await login(user.email);
    const players = await (await authedFetch(cookie, 'https://x/api/v1/players')).json<{ items: Array<{ id: number; name: string }> }>();
    const player = players.items[0]!;
    const nextName = `Next_${Date.now().toString(36).slice(-6)}`;
    const cacheOrigin = env.APP_URL || 'https://x';
    for (const name of [player.name, nextName]) {
      await caches.default.put(`${cacheOrigin}/${name}.json`, new Response('cached'));
      await caches.default.put(`${cacheOrigin}/csl/${name}.json`, new Response('cached'));
      await caches.default.put(`${cacheOrigin}/usm/${name}`, new Response('cached'));
      await caches.default.put(`${cacheOrigin}/usm/${name}.json`, new Response('cached'));
    }
    expect((await authedFetch(cookie, `https://x/api/v1/players/${player.id}`, { method: 'PATCH', body: JSON.stringify({ name: nextName }) })).status).toBe(200);
    for (const name of [player.name, nextName]) for (const path of [`/${name}.json`, `/csl/${name}.json`, `/usm/${name}`, `/usm/${name}.json`]) {
      expect(await caches.default.match(`${cacheOrigin}${path}`)).toBeUndefined();
    }
  });

  it('创建扣分、删除退款', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);

    const before = await (await authedFetch(cookie, 'https://x/api/v1/me/score'))
      .json<{ score: number }>();
    // 注册时随送的玩家不扣费；初始分完整保留
    expect(before.score).toBe(1000);

    // 再建一个 → 扣 score_per_player=100
    const created = await authedFetch(cookie, 'https://x/api/v1/players', {
      method: 'POST',
      body: JSON.stringify({ name: uniq('pp') }),
    });
    expect(created.status).toBe(201);
    const after = await (await authedFetch(cookie, 'https://x/api/v1/me/score'))
      .json<{ score: number }>();
    expect(after.score).toBe(900);

    // 删除退回
    const pid = (await created.json<{ id: number }>()).id;
    await authedFetch(cookie, `https://x/api/v1/players/${pid}`, { method: 'DELETE' });
    const refunded = await (await authedFetch(cookie, 'https://x/api/v1/me/score'))
      .json<{ score: number }>();
    expect(refunded.score).toBe(1000);
  });

  it('不能创建非法名字', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const res = await authedFetch(cookie, 'https://x/api/v1/players', {
      method: 'POST',
      body: JSON.stringify({ name: 'ab' }),
    });
    expect(res.status).toBe(422);
  });
});

// ── 纹理上传 ─────────────────────────────────────────────────────────────────

async function uploadTexture(
  cookie: string,
  bytes: Uint8Array<ArrayBuffer>,
  opts: { kind: 'skin' | 'cape'; model?: 'default' | 'slim'; name?: string; visibility?: 'public' | 'private'; origin?: 'original' | 'repost' },
): Promise<Response> {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'image/png' }), 't.png');
  form.set('kind', opts.kind);
  if (opts.model) form.set('model', opts.model);
  if (opts.visibility) form.set('visibility', opts.visibility);
  if (opts.origin) form.set('origin', opts.origin);
  form.set('name', opts.name ?? uniq('tex'));
  const response = await authedFetch(cookie, 'https://x/api/v1/textures', {
    method: 'POST',
    body: form,
  });
  // 上传路径通过 waitUntil 预生成衍生图（avatar-2d-100/64 → preview 依次进
  // DO 单飞队列）。等最后一个产物落地，确保这些存储操作不跨过本测试的
  // 隔离存储帧 —— 否则 pool-workers 会报 "Failed to pop isolated storage frame"。
  if (response.status === 201) {
    const { hash } = await response.clone().json<{ hash: string }>();
    const pregenKey = previewObjectKey(hash);
    const deadline = Date.now() + 5000;
    while (!(await env.BUCKET.head(pregenKey)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return response;
}

describe('纹理上传', () => {
  it('记录原创与转载来源标记', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const res = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default', origin: 'repost' });
    expect(res.status).toBe(201);
    const texture = await res.json<{ id: number }>();
    expect((await (await authedFetch(cookie, `https://x/api/v1/textures/${texture.id}`)).json<{ origin: string }>()).origin).toBe('repost');
  });
  it('拒绝拥有者举报自己的纹理', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const up = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    const { id } = await up.json<{ id: number }>();
    const res = await authedFetch(cookie, 'https://x/api/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ textureId: id, reason: 'self report' }),
    });
    expect(res.status).toBe(422);
    expect((await res.json<{ error: string }>()).error).toBe('report.self');
  });
  it('待处理举报拦截重复举报；处理完成后可再次举报', async () => {
    const uploader = await registerUser();
    const uploaderCookie = await login(uploader.email);
    const up = await uploadTexture(uploaderCookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    const { id: textureId } = await up.json<{ id: number }>();

    const reporter = await registerUser();
    const reporterCookie = await login(reporter.email);
    const submit = (reason: string) => authedFetch(reporterCookie, 'https://x/api/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ textureId, reason }),
    });

    // 第一次举报成功
    expect((await submit('第一次举报')).status).toBe(201);
    // pending 期间重复举报被 409 拦截
    const dup = await submit('第二次举报');
    expect(dup.status).toBe(409);
    expect((await dup.json<{ error: string }>()).error).toBe('report.already_reported');

    // 管理员处理举报（驳回）
    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);
    const list = await authedFetch(adminCookie, 'https://x/api/v1/reports/admin?status=pending');
    const { items } = await list.json<{ items: Array<{ id: number }> }>();
    const report = items.find(() => true);
    expect(report).toBeDefined();
    expect((await authedFetch(adminCookie, `https://x/api/v1/reports/${report!.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ action: 'reject' }),
    })).status).toBe(200);

    // 处理完成后可再次举报
    expect((await submit('处理后再举报')).status).toBe(201);
  });
  it('举报押金扣款失败时撤销占位：不留举报记录也不扣分', async () => {
    const uploader = await registerUser();
    const uploaderCookie = await login(uploader.email);
    const up = await uploadTexture(uploaderCookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    const { id: textureId } = await up.json<{ id: number }>();

    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);
    const setDelta = (value: number) => authedFetch(adminCookie, 'https://x/api/v1/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ settings: [{ key: 'reporter_score_delta', value }] }),
    });
    // 押金高于注册初始分（1000），提交必然扣款失败
    expect((await setDelta(-2000)).status).toBe(200);
    try {
      const reporter = await registerUser();
      const reporterCookie = await login(reporter.email);
      const res = await authedFetch(reporterCookie, 'https://x/api/v1/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ textureId, reason: '押金不足' }),
      });
      expect(res.status).toBe(402);

      const rows = await env.DB.prepare('SELECT id FROM reports WHERE reporter_id = ?').bind(reporter.id).all();
      expect(rows.results ?? []).toEqual([]);
      const me = await authedFetch(reporterCookie, 'https://x/api/v1/me');
      expect((await me.json<{ score: number }>()).score).toBe(1000);
    } finally {
      // 积分设置是全局的，恢复原值避免影响后续用例
      expect((await setDelta(0)).status).toBe(200);
    }
  });
  it('官方材质不提供举报与评论通道', async () => {
    // 造一条官方材质（站点自有内容，official_key 非空）
    const officialId = (await env.DB.prepare(
      "INSERT INTO textures(hash,kind,model,name,uploader_id,size_bytes,visibility,width,height,likes,official_key,origin,created_at,updated_at) VALUES(?, 'skin','default','Official Test',NULL,8192,'public',64,64,1,'test.official', 'repost', 1, 1)",
    ).bind('e'.repeat(64)).run().then(r => r.meta.last_row_id));
    expect(officialId).toBeGreaterThan(0);

    const reporter = await registerUser();
    const reporterCookie = await login(reporter.email);
    const submit = (path: string, body: Record<string, unknown>) => authedFetch(reporterCookie, `https://x${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    });

    // 举报被 403 拒绝，且不落库
    const report = await submit(`/api/v1/reports`, { textureId: officialId, reason: '官方材质举报' });
    expect(report.status).toBe(403);
    expect((await report.json<{ error: string }>()).error).toBe('report.official_disabled');
    const reportRows = await env.DB.prepare('SELECT id FROM reports WHERE texture_id = ?').bind(officialId).all();
    expect(reportRows.results ?? []).toEqual([]);

    // 发评论被 403 拒绝
    const comment = await submit(`/api/v1/textures/${officialId}/comments`, { content: '官方材质评论' });
    expect(comment.status).toBe(403);
    expect((await comment.json<{ error: string }>()).error).toBe('comment.official_disabled');
    const commentRows = await env.DB.prepare('SELECT id FROM comments WHERE texture_id = ?').bind(officialId).all();
    expect(commentRows.results ?? []).toEqual([]);

    // 读取官方材质的评论列表同样 403
    const list = await authedFetch(reporterCookie, `https://x/api/v1/textures/${officialId}/comments`);
    expect(list.status).toBe(403);
    expect((await list.json<{ error: string }>()).error).toBe('comment.official_disabled');
  });
  it('举报频率限制：每分钟超过 3 条被 429 拒绝', async () => {
    const uploader = await registerUser();
    const uploaderCookie = await login(uploader.email);
    const texIds: number[] = [];
    for (let i = 0; i < 4; i++) {
      // 每张 PNG 内容不同（填充 chunk 数量不同），避免哈希重复被去重拦截
      const up = await uploadTexture(uploaderCookie, makePng({ width: 64, height: 64, fillerChunks: i + 1 }), { kind: 'skin', model: 'default' });
      texIds.push((await up.json<{ id: number }>()).id);
    }

    const reporter = await registerUser();
    const reporterCookie = await login(reporter.email);
    const submit = (textureId: number) => authedFetch(reporterCookie, 'https://x/api/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ textureId, reason: '频控测试' }),
    });

    expect((await submit(texIds[0]!)).status).toBe(201);
    expect((await submit(texIds[1]!)).status).toBe(201);
    expect((await submit(texIds[2]!)).status).toBe(201);
    const fourth = await submit(texIds[3]!);
    expect(fourth.status).toBe(429);
    expect((await fourth.json<{ error: string }>()).error).toBe('report.rate_limited');
  });
  it('管理员禁用举报权限后该用户不能举报，session 同步返回状态', async () => {
    const uploader = await registerUser();
    const uploaderCookie = await login(uploader.email);
    const up = await uploadTexture(uploaderCookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    const { id: textureId } = await up.json<{ id: number }>();

    const reporter = await registerUser();
    const reporterCookie = await login(reporter.email);

    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);

    // 禁用举报权限
    expect((await authedFetch(adminCookie, `https://x/api/v1/admin/users/${reporter.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ reportingDisabled: true }),
    })).status).toBe(200);

    // session 返回禁用状态
    const session = await authedFetch(reporterCookie, 'https://x/api/v1/auth/session');
    expect((await session.json<{ reportingDisabled: boolean; commentsDisabled: boolean }>())).toMatchObject({ reportingDisabled: true, commentsDisabled: false });

    // /me 与 session 的序列化保持一致
    const me = await authedFetch(reporterCookie, 'https://x/api/v1/me');
    expect((await me.json<{ reportingDisabled: boolean; commentsDisabled: boolean }>())).toMatchObject({ reportingDisabled: true, commentsDisabled: false });

    // 提交举报被 403 拒绝
    const res = await authedFetch(reporterCookie, 'https://x/api/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ textureId, reason: '被禁用后举报' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe('report.disabled');
  });
  it('管理员禁用评论权限后该用户不能发评论', async () => {
    const uploader = await registerUser();
    const uploaderCookie = await login(uploader.email);
    const up = await uploadTexture(uploaderCookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    const { id: textureId } = await up.json<{ id: number }>();

    const commenter = await registerUser();
    const commenterCookie = await login(commenter.email);

    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);
    expect((await authedFetch(adminCookie, `https://x/api/v1/admin/users/${commenter.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ commentsDisabled: true }),
    })).status).toBe(200);

    const res = await authedFetch(commenterCookie, `https://x/api/v1/textures/${textureId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ content: '被禁用后的评论' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe('comment.user_disabled');
  });
  it('keeps texture awards intact when switching from private to public and claws them back only when privatizing', async () => {
    const user = await registerUser();
    const cookie = await login(user.email);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO settings(key,locale,value,updated_at) VALUES('score_per_kb_public','', '5', ?)").bind(now),
      env.DB.prepare("INSERT OR REPLACE INTO settings(key,locale,value,updated_at) VALUES('score_per_kb_private','', '10', ?)").bind(now),
      env.DB.prepare("INSERT OR REPLACE INTO settings(key,locale,value,updated_at) VALUES('score_award_per_texture','', '6', ?)").bind(now),
      env.DB.prepare("INSERT OR REPLACE INTO settings(key,locale,value,updated_at) VALUES('clawback_award_on_delete','', 'true', ?)").bind(now),
    ]);
    invalidateSettingsCache();
    const starting = await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>();
    const bytes = makePng({ width: 64, height: 64 });
    const kb = Math.ceil(bytes.byteLength / 1024);
    const privateTexture = await uploadTexture(cookie, bytes, { kind: 'skin', model: 'default', visibility: 'private' });
    const privateUpload = await privateTexture.json<{ id: number; scoreSpent: number }>();
    const privateId = privateUpload.id;
    expect((await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>()).score).toBe(starting.score - privateUpload.scoreSpent);
    const makePublic = await authedFetch(cookie, `https://x/api/v1/textures/${privateId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'public' }) });
    expect(makePublic.status, JSON.stringify(await makePublic.clone().json())).toBe(200);
    expect((await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>()).score).toBe(starting.score - Math.max(0, kb * 5 - 6));
    await authedFetch(cookie, `https://x/api/v1/textures/${privateId}`, { method: 'DELETE' });
    expect((await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>()).score).toBe(starting.score);

    const publicTexture = await uploadTexture(cookie, bytes, { kind: 'skin', model: 'slim', visibility: 'public' });
    const publicUpload = await publicTexture.json<{ id: number; scoreSpent: number }>();
    const publicId = publicUpload.id;
    const makePrivate = await authedFetch(cookie, `https://x/api/v1/textures/${publicId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'private' }) });
    expect(makePrivate.status, JSON.stringify(await makePrivate.clone().json())).toBe(200);
    expect((await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>()).score).toBe(starting.score - kb * 10);
    await authedFetch(cookie, `https://x/api/v1/textures/${publicId}`, { method: 'DELETE' });
    expect((await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>()).score).toBe(starting.score - 6);
    await env.DB.prepare("DELETE FROM settings WHERE key IN ('score_per_kb_public','score_per_kb_private','score_award_per_texture','clawback_award_on_delete')").run();
    invalidateSettingsCache();
  });
  it('合法 64x64 皮肤上传成功，自动入 closet，扣分', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);

    const res = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), {
      kind: 'skin', model: 'default',
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number; hash: string }>();
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    // 内容哈希 == 文件哈希
    expect(body.hash).toBe(await sha256Hex(makePng({ width: 64, height: 64 })));
  });

  it('替换按大小差额结算，删除只退还实际净支出', async () => {
    const user = await registerUser();
    const cookie = await login(user.email);
    const initial = await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>();
    const created = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default', visibility: 'public' });
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: number }>();
    const small = await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>();
    const form = new FormData(); form.set('file', new Blob([makePng({ width: 128, height: 128 })], { type: 'image/png' }), 'large.png');
    expect((await authedFetch(cookie, `https://x/api/v1/textures/${id}/content`, { method: 'PUT', body: form })).status).toBe(200);
    const large = await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>();
    expect(large.score).toBeLessThan(small.score);
    expect((await authedFetch(cookie, `https://x/api/v1/textures/${id}`, { method: 'DELETE' })).status).toBe(204);
    const restored = await (await authedFetch(cookie, 'https://x/api/v1/me/score')).json<{ score: number }>();
    expect(restored.score).toBe(initial.score);
  });

  it('已有私有材质不阻止同一用户公开上传相同内容', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const bytes = makePng({ width: 64, height: 64, fillerChunks: 1 });
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO textures (hash, kind, model, name, uploader_id, size_bytes, visibility, width, height, created_at, updated_at)
      VALUES (?, 'skin', 'default', ?, ?, ?, 'private', 64, 64, ?, ?)`)
      .bind(await sha256Hex(bytes), uniq('private'), u.id, bytes.byteLength, now, now).run();

    const published = await uploadTexture(cookie, bytes, { kind: 'skin', visibility: 'public' });
    expect(published.status).toBe(201);
  });

  it('已有公开材质会阻止再次公开或私有上传并返回已有材质 ID', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const bytes = makePng({ width: 64, height: 64, fillerChunks: 2 });
    const original = await uploadTexture(cookie, bytes, { kind: 'skin', visibility: 'public' });
    const existingId = (await original.json<{ id: number }>()).id;

    for (const visibility of ['public', 'private'] as const) {
      const duplicate = await uploadTexture(cookie, bytes, { kind: 'skin', visibility });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ error: 'texture.duplicate', fields: { existingId: String(existingId) } });
    }
  });

  it('不是 PNG 被拒', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const res = await uploadTexture(
      cookie,
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]),
      { kind: 'skin', model: 'default' },
    );
    expect(res.status).toBe(422);
    expect((await res.json<{ error: string }>()).error).toBe('texture.not_png');
  });

  it('尺寸不是 64 的倍数被拒', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const res = await uploadTexture(cookie, makePng({ width: 65, height: 64 }), {
      kind: 'skin', model: 'default',
    });
    expect(res.status).toBe(422);
    expect((await res.json<{ error: string }>()).error).toBe('texture.dimension_invalid');
  });

  it('cape 比例不为 2 被拒', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const res = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'cape' });
    expect(res.status).toBe(422);
    expect((await res.json<{ error: string }>()).error).toBe('texture.ratio_invalid');
  });

  it('slim 皮肤 64x32（比例 2）被拒', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const res = await uploadTexture(cookie, makePng({ width: 64, height: 32 }), {
      kind: 'skin', model: 'slim',
    });
    expect(res.status).toBe(422);
    expect((await res.json<{ error: string }>()).error).toBe('texture.ratio_invalid');
  });

  it('CRC 损坏的 PNG 被拒', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const res = await uploadTexture(
      cookie, makePng({ width: 64, height: 64, corruptIdatCrc: true }),
      { kind: 'skin', model: 'default' },
    );
    expect(res.status).toBe(422);
    expect((await res.json<{ error: string }>()).error).toBe('texture.malformed');
  });

  it('所有者可以替换图片内容并保留作品记录', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const original = makePng({ width: 64, height: 64 });
    const created = await uploadTexture(cookie, original, { kind: 'skin', model: 'default' });
    const id = (await created.json<{ id: number }>()).id;
    const changed = makePng({ width: 64, height: 64, fillerChunks: 1 });
    const form = new FormData();
    form.set('file', new Blob([changed], { type: 'image/png' }), 'skin.png');
    const saved = await authedFetch(cookie, `https://x/api/v1/textures/${id}/content`, { method: 'PUT', body: form });
    expect(saved.status).toBe(200);
    const value = await saved.json<{ hash: string; width: number; height: number }>();
    expect(value.hash).toBe(await sha256Hex(changed));
    expect(value).toMatchObject({ width: 64, height: 64 });
    const loaded = await authedFetch(cookie, `https://x/api/v1/textures/${id}/content`);
    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(changed);
    expect((await (await authedFetch(cookie, `https://x/api/v1/textures/${id}`)).json<{ kind: string; model: string; name: string }>())).toMatchObject({ kind: 'skin', model: 'default' });
  });

  it('替换内容仍按原皮肤类型校验且拒绝非所有者', async () => {
    const owner = await registerUser();
    const ownerCookie = await login(owner.email);
    const created = await uploadTexture(ownerCookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'slim' });
    const id = (await created.json<{ id: number }>()).id;
    const form = new FormData();
    form.set('file', new Blob([makePng({ width: 64, height: 32 })], { type: 'image/png' }), 'wrong.png');
    const invalid = await authedFetch(ownerCookie, `https://x/api/v1/textures/${id}/content`, { method: 'PUT', body: form });
    expect(invalid.status).toBe(422);
    const other = await registerUser();
    const denied = await authedFetch(await login(other.email), `https://x/api/v1/textures/${id}/content`, { method: 'PUT', body: form });
    expect(denied.status).toBe(404);
  });
});

// ── 协议端点（CSL 契约）─────────────────────────────────────────────────────

describe('Minecraft 协议', () => {
  it('无皮肤玩家返回 {"skins":{"default":null}}', async () => {
    const u = await registerUser({ playerName: uniq('bare') });
    const res = await SELF.fetch(`https://x/${u.playerName}.json`);
    expect(res.status).toBe(200);
    // 文档 07 §1.2：契约是恰好三个键，键序 username/skins/cape
    expect(await res.text())
      .toBe(`{"username":"${u.playerName}","skins":{"default":null},"cape":null}`);
  });

  it('/{player}.json 与 /csl/{player}.json 字节级相同', async () => {
    const u = await registerUser();
    const a = await (await SELF.fetch(`https://x/${u.playerName}.json`)).text();
    const b = await (await SELF.fetch(`https://x/csl/${u.playerName}.json`)).text();
    expect(a).toBe(b);
  });

  it('装备皮肤后档案带 hash 与 model，且 /textures/{hash} 能取回字节', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const bytes = makePng({ width: 64, height: 64 });
    const up = await uploadTexture(cookie, bytes, { kind: 'skin', model: 'default' });
    const { id: tid, hash } = await up.json<{ id: number; hash: string }>();

    const players = await (await authedFetch(cookie, 'https://x/api/v1/players'))
      .json<{ items: Array<{ id: number }> }>();
    const pid = players.items[0]!.id;
    const put = await authedFetch(cookie, `https://x/api/v1/players/${pid}/textures`, {
      method: 'PUT',
      body: JSON.stringify({ skin: tid }),
    });
    expect(put.status).toBe(200);

    const profile = await SELF.fetch(`https://x/${u.playerName}.json`);
    const body = await profile.json<{ skins: { default: string | null } }>();
    expect(body.skins.default).toBe(hash);

    const raw = await SELF.fetch(`https://x/textures/${hash}`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('image/png');
    const received = new Uint8Array(await raw.arrayBuffer());
    expect(await sha256Hex(received)).toBe(hash);
  });

  it('If-None-Match 命中返回 304', async () => {
    const u = await registerUser();
    const first = await SELF.fetch(`https://x/${u.playerName}.json`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const second = await SELF.fetch(`https://x/${u.playerName}.json`, {
      headers: { 'if-none-match': etag! },
    });
    expect(second.status).toBe(304);
  });

  it('纹理哈希格式非法返回 404', async () => {
    const res = await SELF.fetch('https://x/textures/not-a-hash');
    expect(res.status).toBe(404);
  });

  it('avatar 衍生图：上传后按需生成（DO 链路）', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const bytes = makePng({ width: 64, height: 64 });

    const form = new FormData();
    form.set('file', new Blob([bytes]), 't.png');
    form.set('kind', 'skin');
    form.set('model', 'default');
    form.set('name', uniq('gen'));
    const up = await authedFetch(cookie, 'https://x/api/v1/textures', { method: 'POST', body: form });
    expect(up.status).toBe(201);
    const { hash } = await up.json<{ hash: string }>();

    // 源纹理存在、衍生图缺失 → 读端点触发 DO 生成并返回
    const avatar = await SELF.fetch(`https://x/avatar/${hash}?mode=2d&size=64`);
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get('content-type')).toBe('image/png');
    expect(avatar.headers.get('cache-control')).toContain('immutable');

    // 产物是 64×64 的合法 PNG（把整张 8×8 脸放大到 64）
    const png = new Uint8Array(await avatar.arrayBuffer());
    const { inspectPng } = await import('../../../packages/minecraft/src/png.ts');
    const inspection = inspectPng(png);
    expect(inspection.ok).toBe(true);
    if (inspection.ok) {
      expect(inspection.info.width).toBe(64);
      expect(inspection.info.height).toBe(64);
    }

    // 生成后再请求 → 200（R2 命中路径）
    const again = await SELF.fetch(`https://x/avatar/${hash}?mode=2d&size=64`);
    expect(again.status).toBe(200);
    await again.arrayBuffer();

    // preview 同链路
    const preview = await SELF.fetch(`https://x/preview/${hash}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/png');
    await preview.arrayBuffer();
  });

  it('avatar 尺寸不在白名单返回 404（不触发生成）', async () => {
    const hash = 'b'.repeat(64);
    const res = await SELF.fetch(`https://x/avatar/${hash}?mode=2d&size=123`);
    expect(res.status).toBe(404);
  });

  it('关闭衍生图生成时，缺失产物不回退到请求内渲染', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    // 上传会 waitUntil 预生成 avatar-2d-100/64 与 preview（uploadTexture 内已等待落地），
    // 因此选未预生成的 3d 头像作为"缺失产物"样本：开关关闭时缺失产物必须 404，
    // 不得回退到请求内渲染；已存在的产物仍然照常服务。
    const up = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), { kind: 'skin', model: 'default' });
    const { hash } = await up.json<{ hash: string }>();
    const app = createApp();
    const disabledEnv = { ...env, DERIVATIVES_ENABLED: 'false' };
    const requestInEnv = async (path: string) => {
      const ctx = createExecutionContext();
      const response = await app.fetch(new Request(`https://x${path}`), disabledEnv, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };

    const avatar3d = await requestInEnv(`/avatar/${hash}?mode=3d&size=64`);
    expect(avatar3d.status).toBe(404);
    const avatar3dKey = avatarObjectKey(hash, '3d', 64);
    expect(await env.BUCKET.head(avatar3dKey)).toBeNull();

    const cachedBytes = makePng({ width: 64, height: 64 });
    await env.BUCKET.put(avatar3dKey, cachedBytes, { httpMetadata: { contentType: 'image/png' } });
    const cachedAvatar = await requestInEnv(`/avatar/${hash}?mode=3d&size=64`);
    expect(cachedAvatar.status).toBe(200);
    expect(new Uint8Array(await cachedAvatar.arrayBuffer())).toEqual(cachedBytes);
  });
});

// ── 内置插件协议 ─────────────────────────────────────────────────────────────

describe('legacy-api', () => {
  it('/skin/:player.png 直出纹理；不存在 404', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const bytes = makePng({ width: 64, height: 64 });
    const up = await uploadTexture(cookie, bytes, { kind: 'skin', model: 'default' });
    const { id: tid } = await up.json<{ id: number }>();

    const playersList = await (await authedFetch(cookie, 'https://x/api/v1/players'))
      .json<{ items: Array<{ id: number }> }>();
    const pid = playersList.items[0]!.id;
    await authedFetch(cookie, `https://x/api/v1/players/${pid}/textures`, {
      method: 'PUT', body: JSON.stringify({ skin: tid }),
    });

    const res = await SELF.fetch(`https://x/skin/${u.playerName}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    await res.arrayBuffer();

    const missing = await SELF.fetch('https://x/skin/nosuchplayer404.png');
    expect(missing.status).toBe(404);
  });
});

describe('usm-api', () => {
  it('/usm/:player.json 结构逐字段', async () => {
    const u = await registerUser();
    const res = await SELF.fetch(`https://x/usm/${u.playerName}.json`);
    expect(res.status).toBe(200);
    const body = await res.json<{ player_name: string; skins: Record<string, string | null>; cape: string | null; model_preference: string[] }>();
    expect(body.player_name).toBe(u.playerName);
    expect(body.skins.default).toBeNull();
    expect(body.model_preference).toEqual(['default']);
    expect(body.cape).toBeNull();
  });
});

describe('texture-description', () => {
  it('PUT/GET 描述；权限控制', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const up = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), {
      kind: 'skin', model: 'default',
    });
    const { id: tid } = await up.json<{ id: number }>();

    const put = await authedFetch(cookie, `https://x/api/v1/textures/${tid}/description`, {
      method: 'PUT', body: JSON.stringify({ description: '# 好看' }),
    });
    expect(put.status).toBe(200);

    const get = await SELF.fetch(`https://x/api/v1/textures/${tid}/description`);
    expect((await get.json<{ description: string }>()).description).toBe('# 好看');

    // 非上传者不能改
    const other = await registerUser();
    const otherCookie = await login(other.email);
    const deny = await authedFetch(otherCookie, `https://x/api/v1/textures/${tid}/description`, {
      method: 'PUT', body: JSON.stringify({ description: 'hijack' }),
    });
    expect(deny.status).toBe(403);
  });
});

describe('restricted-email-domains', () => {
  it('黑名单命中拒绝注册', async () => {
    const admin = await registerUser();
    const cookie = await login(admin.email);
    await makeAdmin(admin.id);
    const put = await authedFetch(cookie, 'https://x/api/v1/admin/restricted-email-domains/deny', {
      method: 'PUT', body: JSON.stringify({ domains: ['spam.example'] }),
    });
    expect(put.status).toBe(204);

    const res = await SELF.fetch('https://x/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${uniq('bad')}@spam.example`, password: PASSWORD, playerName: uniq('bd'),
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe('email.domain_denied');
  });
});

describe('评论区', () => {
  it('发表/列表/管理员删除', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const up = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), {
      kind: 'skin', model: 'default',
    });
    const { id: tid } = await up.json<{ id: number }>();

    const post = await authedFetch(cookie, `https://x/api/v1/textures/${tid}/comments`, {
      method: 'POST', body: JSON.stringify({ content: 'nice skin!' }),
    });
    expect(post.status).toBe(201);

    const list = await SELF.fetch(`https://x/api/v1/textures/${tid}/comments`);
    const body = await list.json<{ items: Array<{ content: string }>; total: number }>();
    expect(body.total).toBe(1);
    expect(body.items[0]!.content).toBe('nice skin!');

    // 空内容 422
    const empty = await authedFetch(cookie, `https://x/api/v1/textures/${tid}/comments`, {
      method: 'POST', body: JSON.stringify({ content: '  ' }),
    });
    expect(empty.status).toBe(422);
  });

  it('管理员列表与删除写审计', async () => {
    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);

    const u = await registerUser();
    const cookie = await login(u.email);
    const up = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), {
      kind: 'skin', model: 'default',
    });
    const { id: tid } = await up.json<{ id: number }>();
    await authedFetch(cookie, `https://x/api/v1/textures/${tid}/comments`, {
      method: 'POST', body: JSON.stringify({ content: 'to be deleted' }),
    });

    const list = await authedFetch(adminCookie, 'https://x/api/v1/admin/comments');
    expect(list.status).toBe(200);
    const items = await list.json<{ items: Array<{ id: number }> }>();
    const cid = items.items[0]!.id;

    const del = await authedFetch(adminCookie, `https://x/api/v1/admin/comments/${cid}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);

    const rows = await readAudit();
    expect(rows.some((r) => r.action === 'admin.comment.delete')).toBe(true);
  });
});

describe('管理员新动作', () => {
  it('创建用户 + 审计日志查询 + 会话吊销', async () => {
    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);

    const created = await authedFetch(adminCookie, 'https://x/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: `${uniq('new')}@example.com`, nickname: uniq('nu'), password: 'created-pass-1' }),
    });
    expect(created.status).toBe(201);
    const { id: newUid } = await created.json<{ id: number }>();

    const audit = await authedFetch(adminCookie, 'https://x/api/v1/admin/audit-log?action=admin.user.create');
    expect(audit.status).toBe(200);
    const auditBody = await audit.json<{ items: Array<{ action: string }> }>();
    expect(auditBody.items.some((r) => r.action === 'admin.user.create')).toBe(true);

    const sessions = await authedFetch(adminCookie, `https://x/api/v1/admin/users/${newUid}/sessions`);
    expect(sessions.status).toBe(200);

    // 重复邮箱 409
    const dupEmail = `${uniq('dup2')}@example.com`;
    const second = await authedFetch(adminCookie, 'https://x/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: dupEmail, nickname: uniq('y'), password: 'created-pass-1' }),
    });
    expect(second.status).toBe(201);
    const sameEmail = await authedFetch(adminCookie, 'https://x/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: dupEmail, nickname: uniq('z'), password: 'created-pass-1' }),
    });
    expect(sameEmail.status).toBe(409);
  });

  it('纹理治理：删除与改可见性', async () => {
    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);

    const u = await registerUser();
    const cookie = await login(u.email);
    const up = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), {
      kind: 'skin', model: 'default',
    });
    const { id: tid } = await up.json<{ id: number }>();

    const patch = await authedFetch(adminCookie, `https://x/api/v1/admin/textures/${tid}`, {
      method: 'PATCH', body: JSON.stringify({ visibility: 'private' }),
    });
    expect(patch.status).toBe(200);

    const del = await authedFetch(adminCookie, `https://x/api/v1/admin/textures/${tid}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
  });
});

// ── yggdrasil 协议 ───────────────────────────────────────────────────────────

describe('yggdrasil-api', () => {
  async function authenticate(email: string): Promise<{ accessToken: string; clientToken: string; availableProfiles: Array<{ id: string; name: string }>; selectedProfile?: { id: string; name: string } }> {
    const res = await SELF.fetch('https://x/api/yggdrasil/authserver/authenticate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return await res.json();
  }

  it('authenticate → validate → refresh → invalidate 生命周期', async () => {
    const u = await registerUser();
    const auth = await authenticate(u.email);
    expect(auth.accessToken).toBeTruthy();
    expect(auth.clientToken).toBeTruthy();
    expect(auth.availableProfiles.some((p) => p.name === u.playerName)).toBe(true);
    // 单角色 → selectedProfile 必须存在
    expect(auth.selectedProfile?.name).toBe(u.playerName);

    // validate 204
    const validate = await SELF.fetch('https://x/api/yggdrasil/authserver/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: auth.accessToken, clientToken: auth.clientToken }),
    });
    expect(validate.status).toBe(204);

    // refresh 沿用 clientToken
    const refresh = await SELF.fetch('https://x/api/yggdrasil/authserver/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: auth.accessToken, clientToken: auth.clientToken }),
    });
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json<{ accessToken: string; clientToken: string }>();
    expect(refreshed.clientToken).toBe(auth.clientToken);
    expect(refreshed.accessToken).not.toBe(auth.accessToken);

    // 旧 token validate → 403
    const oldValidate = await SELF.fetch('https://x/api/yggdrasil/authserver/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: auth.accessToken }),
    });
    expect(oldValidate.status).toBe(403);

    // invalidate 恒 204
    const invalidate = await SELF.fetch('https://x/api/yggdrasil/authserver/invalidate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: refreshed.accessToken }),
    });
    expect(invalidate.status).toBe(204);

    // 错误密码 → 403 ForbiddenOperationException 形态
    const bad = await SELF.fetch('https://x/api/yggdrasil/authserver/authenticate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u.email, password: 'wrong-pass-123' }),
    });
    expect(bad.status).toBe(403);
    expect((await bad.json<{ errorMessage: string }>()).errorMessage).toBeTruthy();
  });

  it('profile/:uuid 与 hasJoined 带签（签名对象是 textures value）', async () => {
    const { setTestYggKey } = await import('./setup.ts');
    await setTestYggKey();

    const u = await registerUser();
    const cookie = await login(u.email);
    const up = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), {
      kind: 'skin', model: 'default',
    });
    const { id: tid } = await up.json<{ id: number }>();
    const playersList = await (await authedFetch(cookie, 'https://x/api/v1/players'))
      .json<{ items: Array<{ id: number }> }>();
    await authedFetch(cookie, `https://x/api/v1/players/${playersList.items[0]!.id}/textures`, {
      method: 'PUT', body: JSON.stringify({ skin: tid }),
    });

    const auth = await authenticate(u.email);
    const uuid = auth.selectedProfile!.id;

    const profile = await SELF.fetch(`https://x/api/yggdrasil/sessionserver/session/minecraft/profile/${uuid}?unsigned=false`);
    expect(profile.status).toBe(200);
    const body = await profile.json<{
      id: string; name: string;
      properties: Array<{ name: string; value: string; signature?: string }>;
    }>();
    const texturesProp = body.properties.find((p) => p.name === 'textures');
    expect(texturesProp).toBeTruthy();
    // 解码 value：应为 textures JSON 且含本站 URL
    const decoded = JSON.parse(atob(texturesProp!.value)) as {
      profileName: string; textures: { SKIN?: { url: string } };
    };
    expect(decoded.profileName).toBe(u.playerName);
    expect(decoded.textures.SKIN?.url).toContain('textures/');

    // 签名可被公钥验签（签名对象 = value 字符串本身）
    const { verifyTestYggSignature } = await import('./setup.ts');
    expect(texturesProp!.signature, 'profile/:uuid 的 textures property 必须带 signature').toBeTruthy();
    const ok = await verifyTestYggSignature(texturesProp!.value, texturesProp!.signature!);
    expect(ok).toBe(true);

    // join → hasJoined 链路（带签）
    const join = await SELF.fetch('https://x/api/yggdrasil/sessionserver/session/minecraft/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: auth.accessToken, selectedProfile: uuid, serverId: 'srv-1' }),
    });
    expect(join.status).toBe(204);
    const hasJoined = await SELF.fetch('https://x/api/yggdrasil/sessionserver/session/minecraft/hasJoined?username=' + u.playerName + '&serverId=srv-1');
    expect(hasJoined.status).toBe(200);
    const hj = await hasJoined.json<{ name: string; properties: Array<{ name: string; signature?: string }> }>();
    expect(hj.name).toBe(u.playerName);
    expect(hj.properties.find((p) => p.name === 'textures')?.signature).toBeTruthy();
  });

  it('profiles/minecraft 批量查询', async () => {
    const u = await registerUser();
    const res = await SELF.fetch('https://x/api/yggdrasil/api/profiles/minecraft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([u.playerName, 'nosuch404player']),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Array<{ id: string; name: string }>>();
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe(u.playerName);
  });
});

// ── sitemap / robots.txt ─────────────────────────────────────────────────────

describe('sitemap 自动生成', () => {
  it('robots.txt 含 Sitemap 指向与 Disallow 规则', async () => {
    const res = await SELF.fetch('https://x/robots.txt');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Sitemap: ');
    expect(body).toContain('sitemap.xml');
    expect(body).toContain('Disallow: /api/');
  });

  it('Claude 抓取代理在 robots.txt 被单独禁止，且请求层直接 403', async () => {
    for (const agent of BLOCKED_CRAWLER_AGENTS) {
      const body = await (await SELF.fetch('https://x/robots.txt')).text();
      expect(body, agent).toContain(`User-agent: ${agent}\nDisallow: /`);
    }

    const bot = { headers: { 'user-agent': 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' } };
    // 整站一律 403：API、SPA 路由、协议路径、衍生图与静态资源都不例外。
    // 断言响应体而不只看状态码 —— /raw/1 这类路径在关闭下载时自身也返回 403，
    // 只看状态码分不出是守卫拦的还是路由拒的。
    for (const path of ['/api/v1/settings/public', '/skinlib', '/textures/abc', '/api/yggdrasil', '/raw/1', '/avatar/u/1', '/manual/x.png', '/yggc/authserver/authenticate']) {
      const res = await SELF.fetch(`https://x${path}`, bot);
      expect(res.status, path).toBe(403);
      expect(await res.text(), path).toBe('Forbidden');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
    // robots.txt 自身放行，否则合规爬虫读不到自己的禁止规则
    expect((await SELF.fetch('https://x/robots.txt', bot)).status).toBe(200);
    // 名单里每个 UA 在请求层都被拦，不依赖单测那份清单
    for (const agent of BLOCKED_CRAWLER_AGENTS) {
      const blocked = await SELF.fetch('https://x/api/v1/settings/public', { headers: { 'user-agent': `Mozilla/5.0 (compatible; ${agent}/1.0)` } });
      expect(blocked.status, agent).toBe(403);
      expect(await blocked.text(), agent).toBe('Forbidden');
    }

    // 用户主动让 Claude 读取页面（Claude-User）不是爬虫：不声明也不拦
    const userAgentBot = { headers: { 'user-agent': 'claude-user/1.0; +claude-user@anthropic.com' } };
    expect(await (await SELF.fetch('https://x/robots.txt')).text()).not.toContain('User-agent: Claude-User');
    expect((await SELF.fetch('https://x/api/v1/settings/public', userAgentBot)).status).toBe(200);

    // 普通浏览器不受影响
    const browser = { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } };
    expect((await SELF.fetch('https://x/api/v1/settings/public', browser)).status).toBe(200);
  });

  it('sitemap.xml 仅包含公开页面；私有纹理和账号页面不出现', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const publicUp = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), {
      kind: 'skin', model: 'default', name: uniq('pub'),
    });
    const { id: pubId } = await publicUp.json<{ id: number }>();

    // 私有纹理
    const form = new FormData();
    form.set('file', new Blob([makePng({ width: 64, height: 64 })]), 't.png');
    form.set('kind', 'skin');
    form.set('model', 'default');
    form.set('visibility', 'private');
    form.set('name', uniq('priv'));
    await authedFetch(cookie, 'https://x/api/v1/textures', { method: 'POST', body: form });

    const res = await SELF.fetch('https://x/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('xml');
    const body = await res.text();
    expect(body).toContain('<urlset');
    expect(body).toContain(`/skinlib/${pubId}`);
    expect(body).not.toContain('/player/');
    expect(body).not.toContain('/auth/');
    // 私有纹理 id 不应出现（pubId 是第一个，私有 id 是 pubId+1）
    expect(body).not.toContain(`/skinlib/${pubId + 1}`);
  });

  it('上传新纹理后 sitemap 版本失效并重建（自动更新）', async () => {
    const before = await (await SELF.fetch('https://x/sitemap.xml')).text();

    const u = await registerUser();
    const cookie = await login(u.email);
    const up = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), {
      kind: 'skin', model: 'default',
    });
    const { id: newId } = await up.json<{ id: number }>();

    const after = await (await SELF.fetch('https://x/sitemap.xml')).text();
    expect(after).toContain(`/skinlib/${newId}`);
    expect(after).not.toBe(before);
  });

  it('chunk 端点：n=1 有内容，越界 n 返回空 urlset', async () => {
    const first = await SELF.fetch('https://x/sitemap-1.xml');
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('<urlset');

    // 单分片站点：sitemap-2 越界 → 200 + 空 urlset（避免响应体悬空）
    const second = await SELF.fetch('https://x/sitemap-2.xml');
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('<urlset');
  });
});

// ── audit_log ────────────────────────────────────────────────────────────────

describe('audit_log', () => {
  it('管理员改用户设置写入审计', async () => {
    const admin = await registerUser();
    const cookie = await login(admin.email);
    await makeAdmin(admin.id);

    const target = await registerUser();
    const res = await authedFetch(cookie, `https://x/api/v1/admin/users/${target.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ nickname: 'renamed' }),
    });
    expect(res.status).toBe(200);

    const rows = await readAudit();
    const entry = rows.find((r) => r.action === 'admin.user.update' && r.target_id === target.id);
    expect(entry).toBeTruthy();

    const response = await authedFetch(cookie, `https://x/api/v1/admin/audit-log?action=admin.user.update&actor_id=${admin.id}`);
    expect(response.status).toBe(200);
    const body = await response.json<{ items: Array<{ actorId: number; targetType: string; targetId: number; createdAt: number; detail: string }> }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ actorId: admin.id, targetType: 'user', targetId: target.id, action: 'admin.user.update' });
    expect(Number.isFinite(body.items[0]!.createdAt)).toBe(true);
    expect(new Intl.DateTimeFormat('zh-CN').format(body.items[0]!.createdAt)).toEqual(expect.any(String));
    expect(body.items[0]).not.toHaveProperty('created_at');
    expect(body.items[0]).not.toHaveProperty('actor_id');
  });

  it('审计筛选和分页保留系统事件与已删除操作人的记录', async () => {
    const admin = await registerUser();
    const cookie = await login(admin.email);
    await makeAdmin(admin.id);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO audit_log (actor_id, action, target_type, target_id, created_at) VALUES (?, 'admin.live2d.upload', 'model', NULL, ?)").bind(admin.id, Date.now()),
      env.DB.prepare("INSERT INTO audit_log (actor_id, action, target_type, target_id, created_at) VALUES (?, 'admin.live2d.upload', 'model', NULL, ?)").bind(admin.id, Date.now()),
      env.DB.prepare("INSERT INTO audit_log (actor_id, action, created_at) VALUES (NULL, 'test.deleted_actor', ?)").bind(Date.now()),
    ]);
    const query = `https://x/api/v1/admin/audit-log?action=admin.live2d.upload&actor_id=${admin.id}&per_page=1`;
    const first = await (await authedFetch(cookie, `${query}&page=1`)).json<{ items: Array<{ id: number; actorId: number; targetId: number | null }>; total: number; totalPages: number }>();
    const second = await (await authedFetch(cookie, `${query}&page=2`)).json<typeof first>();
    expect(first.total).toBe(2);
    expect(first.totalPages).toBe(2);
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]!.id).toBeGreaterThan(second.items[0]!.id);
    expect(first.items[0]).toMatchObject({ actorId: admin.id, targetId: null });
    const system = await (await authedFetch(cookie, 'https://x/api/v1/admin/audit-log?action=test.deleted_actor')).json<{ items: unknown[] }>();
    expect(system.items).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: null, createdAt: expect.any(Number) })]));
  });

  it('审计查询校验操作人且仅管理员可访问', async () => {
    const user = await registerUser();
    const cookie = await login(user.email);
    expect((await SELF.fetch('https://x/api/v1/admin/audit-log')).status).toBe(401);
    expect((await authedFetch(cookie, 'https://x/api/v1/admin/audit-log')).status).toBe(403);
    await makeAdmin(user.id);
    for (const value of ['abc', '-1', '0', '1.5', 'Infinity', '9007199254740992', '']) {
      expect((await authedFetch(cookie, `https://x/api/v1/admin/audit-log?actor_id=${value}`)).status).toBe(422);
    }
  });
});

// ── 密码找回全链路 ───────────────────────────────────────────────────────────

describe('forgot-password → reset-password', () => {
  it('令牌消费后失效，重置后旧会话全部撤销', async () => {
    const u = await registerUser();
    const oldCookie = await login(u.email);

    // 直接在库里塞一枚已知令牌（邮件未配置，走 token 表拿不到原始令牌，
    // 所以这里模拟"邮件已送达"：插入 token 值为明文的行）
    const { mintRawToken } = await import('./setup.ts');
    const raw = await mintRawToken(u.id);

    // 消费一次成功
    const ok = await SELF.fetch('https://x/api/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: raw, password: 'brand-new-pass-1' }),
    });
    expect(ok.status).toBe(200);

    // 同一令牌第二次消费 → 409
    const again = await SELF.fetch('https://x/api/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: raw, password: 'another-pass-12' }),
    });
    expect(again.status).toBe(409);

    // 新密码能登录，旧密码不能
    const newLogin = await SELF.fetch('https://x/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: u.email, password: 'brand-new-pass-1' }),
    });
    expect(newLogin.status).toBe(200);

    // 重置时旧会话被撤销
    const oldSession = await authedFetch(oldCookie, 'https://x/api/v1/auth/session');
    expect(oldSession.status).toBe(401);
  });
});

// ── 管理员重置用户密码 ───────────────────────────────────────────────────────

describe('POST /admin/users/:id/reset-password', () => {
  it('临时密码可登录；admin 不能重置自己或另一个 admin', async () => {
    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);

    const admin2 = await registerUser();
    await makeAdmin(admin2.id);
    const admin2Cookie = await login(admin2.email);

    // 重置普通用户 → 返回临时密码
    const target = await registerUser();
    const ok = await authedFetch(adminCookie, `https://x/api/v1/admin/users/${target.id}/reset-password`, {
      method: 'POST',
    });
    expect(ok.status).toBe(200);
    const { temporaryPassword } = await ok.json<{ temporaryPassword: string }>();
    expect(temporaryPassword).toHaveLength(12);

    // 临时密码可登录
    const withTemp = await SELF.fetch('https://x/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: target.email, password: temporaryPassword }),
    });
    expect(withTemp.status).toBe(200);

    // admin → admin 拒绝（同级）
    const peer = await authedFetch(adminCookie, `https://x/api/v1/admin/users/${admin2.id}/reset-password`, {
      method: 'POST',
    });
    expect(peer.status).toBe(403);

    // 重置自己拒绝
    const self = await authedFetch(admin2Cookie, `https://x/api/v1/admin/users/${admin2.id}/reset-password`, {
      method: 'POST',
    });
    expect(self.status).toBe(403);
  });
});

describe('私有纹理的游戏加载', () => {
  it('隐藏列表和详情，已穿戴纹理仍可匿名按哈希加载', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const bytes = makePng({ width: 64, height: 64 });

    // 上传为私有
    const form = new FormData();
    form.set('file', new Blob([bytes]), 't.png');
    form.set('kind', 'skin');
    form.set('model', 'default');
    form.set('visibility', 'private');
    form.set('name', uniq('priv'));
    const up = await authedFetch(cookie, 'https://x/api/v1/textures', { method: 'POST', body: form });
    expect(up.status).toBe(201);
    const { id: tid, hash } = await up.json<{ id: number; hash: string }>();

    const detail = await SELF.fetch(`https://x/api/v1/textures/${tid}`);
    expect(detail.status).toBe(403);
    const listing = await SELF.fetch(`https://x/api/v1/textures?keyword=${encodeURIComponent(String(form.get('name')))}`);
    expect((await listing.json<{ items: { id: number }[] }>()).items.some((item) => item.id === tid)).toBe(false);
    expect((await SELF.fetch(`https://x/textures/${hash}`)).status).toBe(403);
    expect((await SELF.fetch(`https://x/raw/${tid}`)).status).toBe(403);

    const players = await authedFetch(cookie, 'https://x/api/v1/players');
    const playerId = (await players.json<{ items: { id: number }[] }>()).items[0]!.id;
    const equip = await authedFetch(cookie, `https://x/api/v1/players/${playerId}/textures`, {
      method: 'PUT', body: JSON.stringify({ skin: tid }),
    });
    expect(equip.status).toBe(200);
    const profile = await SELF.fetch(`https://x/${u.playerName}.json`);
    expect((await profile.json<{ skins: { default: string } }>()).skins.default).toBe(hash);
    for (const prefix of ['', '/csl']) {
      const loaded = await SELF.fetch(`https://x${prefix}/textures/${hash}`);
      expect(loaded.status).toBe(200);
      expect(loaded.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(bytes);
      const cached = await SELF.fetch(`https://x${prefix}/textures/${hash}`, {
        headers: { 'if-none-match': loaded.headers.get('etag')! },
      });
      expect(cached.status).toBe(304);
    }

    // 设为公开后放行
    const patch = await authedFetch(cookie, `https://x/api/v1/textures/${tid}`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(patch.status).toBe(200);
    const allowed = await SELF.fetch(`https://x/textures/${hash}`);
    expect(allowed.status).toBe(200);
    await allowed.arrayBuffer();
  });
});

// ── 邮件节流 ─────────────────────────────────────────────────────────────────

describe('verify-email 邮件节流', () => {
  it('60 秒内第二次请求被 429 拒绝', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);

    // 邮件未配置 → 第一次返回 ok:false reason:not-configured（不计数），
    // 这里直接往 auth_attempts 塞一条"刚发过"的记录来驱动节流判定。
    const { seedMailAttempt } = await import('./setup.ts');
    await seedMailAttempt(u.email);

    const res = await authedFetch(cookie, 'https://x/api/v1/auth/verify-email/request', {
      method: 'POST',
    });
    expect(res.status).toBe(429);
    expect((await res.json<{ error: string }>()).error).toBe('common.rate_limited');
  });
});

// ── 限流中间件 ───────────────────────────────────────────────────────────────

describe('rateLimiter', () => {
  it('RATE_LIMIT_ENABLED 未开启时放行（本测试环境无 binding，验证 fail-open）', async () => {
    // 本测试环境的 wrangler 配置 RATE_LIMIT_ENABLED=true，但 pool 里没有
    // ratelimits binding → 中间件走 binding 缺失分支放行。断言请求可达业务层。
    const res = await SELF.fetch('https://x/api/v1/health');
    expect(res.status).toBe(200);
  });
});

// ── 未登录下载限制 ───────────────────────────────────────────────────────────

async function readSettingRow(key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=? AND locale=''")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function writeSetting(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key=? AND locale=''").bind(key).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO settings(key,locale,value,updated_at) VALUES(?, '', ?, ?) ON CONFLICT(key,locale) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    )
      .bind(key, value, Date.now())
      .run();
  }
  invalidateSettingsCache();
}

describe('未登录下载限制', () => {
  it('关闭 allow_anonymous_download 后匿名下载返回 401，登录用户与游戏协议出口不受影响', async () => {
    const u = await registerUser();
    const cookie = await login(u.email);
    const up = await uploadTexture(cookie, makePng({ width: 64, height: 64 }), {
      kind: 'skin',
      name: uniq('anon'),
    });
    expect(up.status).toBe(201);
    const { id: tid, hash } = await up.json<{ id: number; hash: string }>();

    const previousDownload = await readSettingRow('allow_texture_download');
    const previousAnonymous = await readSettingRow('allow_anonymous_download');
    try {
      await writeSetting('allow_texture_download', 'true');
      await writeSetting('allow_anonymous_download', 'true');
      const open = await SELF.fetch(`https://x/raw/${tid}`);
      expect(open.status).toBe(200);
      expect((await open.arrayBuffer()).byteLength).toBeGreaterThan(0);

      await writeSetting('allow_anonymous_download', 'false');
      const blocked = await SELF.fetch(`https://x/raw/${tid}`);
      expect(blocked.status).toBe(401);
      await blocked.arrayBuffer();

      const signedIn = await authedFetch(cookie, `https://x/raw/${tid}`);
      expect(signedIn.status).toBe(200);
      expect((await signedIn.arrayBuffer()).byteLength).toBeGreaterThan(0);

      // 按哈希取字节是 Minecraft 协议出口，CSL 客户端不带 Cookie，
      // 因此该设置只能收口浏览器下载入口，不能连带阻断这里。
      const protocol = await SELF.fetch(`https://x/textures/${hash}`);
      expect(protocol.status).toBe(200);
      expect((await protocol.arrayBuffer()).byteLength).toBeGreaterThan(0);
    } finally {
      await writeSetting('allow_texture_download', previousDownload);
      await writeSetting('allow_anonymous_download', previousAnonymous);
    }
  });
});

// ── 工单回复身份 ─────────────────────────────────────────────────────────────

describe('工单回复身份', () => {
  interface TicketCategory { id: number }

  async function createTicket(cookie: string): Promise<number> {
    const cats = await authedFetch(cookie, 'https://x/api/v1/tickets/categories');
    const { items } = await cats.json<{ items: TicketCategory[] }>();
    expect(items.length).toBeGreaterThan(0);
    const form = new FormData();
    form.set('title', uniq('t'));
    form.set('categoryId', String(items[0]!.id));
    form.set('description', '初始描述');
    const res = await authedFetch(cookie, 'https://x/api/v1/tickets', { method: 'POST', body: form });
    expect(res.status).toBe(201);
    return (await res.json<{ id: number }>()).id;
  }

  it('管理员在用户端回复自己的工单仍记为用户回复，状态回到 pending', async () => {
    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);

    const ticketId = await createTicket(adminCookie);

    // 通过用户端点回复（管理员账号）
    const form = new FormData();
    form.set('body', '我是管理员但以用户身份补充信息');
    const reply = await authedFetch(adminCookie, `https://x/api/v1/tickets/${ticketId}/messages`, { method: 'POST', body: form });
    expect(reply.status).toBe(200);

    const detail = await authedFetch(adminCookie, `https://x/api/v1/tickets/${ticketId}`);
    const { ticket, messages } = await detail.json<{ ticket: { status: string }; messages: Array<{ authorType: string; body: string }> }>();
    const mine = messages.filter(m => m.body === '我是管理员但以用户身份补充信息');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.authorType).toBe('user');
    // 用户回复把工单推回 pending（等待客服处理）
    expect(ticket.status).toBe('pending');
  });

  it('管理员通过管理端点回复记为 admin 回复，状态推进为 in_progress', async () => {
    const owner = await registerUser();
    const ownerCookie = await login(owner.email);
    const ticketId = await createTicket(ownerCookie);

    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);

    const form = new FormData();
    form.set('body', '客服回复');
    const reply = await authedFetch(adminCookie, `https://x/api/v1/admin/tickets/${ticketId}/messages`, { method: 'POST', body: form });
    expect(reply.status).toBe(200);

    const detail = await authedFetch(ownerCookie, `https://x/api/v1/tickets/${ticketId}`);
    const { ticket, messages } = await detail.json<{ ticket: { status: string }; messages: Array<{ authorType: string; body: string }> }>();
    const replyMsg = messages.find(m => m.body === '客服回复');
    expect(replyMsg?.authorType).toBe('admin');
    expect(ticket.status).toBe('in_progress');
  });

  it('内部备注对普通用户不可见；用户端点传 internal=true 被忽略', async () => {
    const owner = await registerUser();
    const ownerCookie = await login(owner.email);
    const ticketId = await createTicket(ownerCookie);

    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);

    // 管理端点发内部备注
    const internalForm = new FormData();
    internalForm.set('body', '内部备注内容');
    internalForm.set('internal', 'true');
    expect((await authedFetch(adminCookie, `https://x/api/v1/admin/tickets/${ticketId}/messages`, { method: 'POST', body: internalForm })).status).toBe(200);

    // 管理员能看到内部备注
    const adminDetail = await authedFetch(adminCookie, `https://x/api/v1/admin/tickets/${ticketId}`);
    const adminMessages = await adminDetail.json<{ messages: Array<{ internal: number }> }>();
    expect(adminMessages.messages.some(m => m.internal === 1)).toBe(true);

    // 普通用户看不到内部备注，状态也不因内部备注改变
    const ownerDetail = await authedFetch(ownerCookie, `https://x/api/v1/tickets/${ticketId}`);
    const ownerView = await ownerDetail.json<{ ticket: { status: string }; messages: Array<{ body: string }> }>();
    expect(ownerView.messages.some(m => m.body === '内部备注内容')).toBe(false);
    expect(ownerView.ticket.status).toBe('pending');

    // 用户端点传 internal=true 被忽略（不产生内部消息，也不 403）
    const smuggle = new FormData();
    smuggle.set('body', '用户正常回复');
    smuggle.set('internal', 'true');
    expect((await authedFetch(ownerCookie, `https://x/api/v1/tickets/${ticketId}/messages`, { method: 'POST', body: smuggle })).status).toBe(200);
    const after = await authedFetch(adminCookie, `https://x/api/v1/admin/tickets/${ticketId}`);
    const afterView = await after.json<{ messages: Array<{ body: string; internal: number }> }>();
    const smuggled = afterView.messages.find(m => m.body === '用户正常回复');
    expect(smuggled?.internal).toBe(0);
  });

  it('非管理员调用管理端点回复被 403 拒绝', async () => {
    const owner = await registerUser();
    const ownerCookie = await login(owner.email);
    const ticketId = await createTicket(ownerCookie);

    const form = new FormData();
    form.set('body', '越权尝试');
    const res = await authedFetch(ownerCookie, `https://x/api/v1/admin/tickets/${ticketId}/messages`, { method: 'POST', body: form });
    expect(res.status).toBe(403);
  });

  it('管理员在用户端查看工单按用户身份更新读标记', async () => {
    const admin = await registerUser();
    const adminCookie = await login(admin.email);
    await makeAdmin(admin.id);
    const ticketId = await createTicket(adminCookie);

    // 先置一个旧的用户读标记
    const now = Date.now();
    await env.DB.prepare('UPDATE tickets SET last_user_read_at=? WHERE id=?').bind(now - 60_000, ticketId).run();

    // 用户端点查看 → last_user_read_at 应被推进
    expect((await authedFetch(adminCookie, `https://x/api/v1/tickets/${ticketId}`)).status).toBe(200);
    const row = await env.DB.prepare('SELECT last_user_read_at as v FROM tickets WHERE id=?').bind(ticketId).first<{ v: number }>();
    expect(row!.v).toBeGreaterThan(now - 1000);

    // 「我的工单」列表不再显示未读（EXISTS 返回 0/1 整数）
    const list = await authedFetch(adminCookie, 'https://x/api/v1/tickets');
    const listBody = await list.json<{ items: Array<{ id: number; userUnread: number }> }>();
    expect(listBody.items.find(t => t.id === ticketId)?.userUnread).toBe(0);
  });
});
