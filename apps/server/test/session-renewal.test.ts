// 会话寿命契约回归：
// 1. 滑动续期（renewSession）只能"延长 + 被绝对上限封顶"，不能缩短；
// 2. 没有记住我勾选框的登录路径（注册/OAuth 换发/账号初始化）按记住会话签发。
//
// 背景：记住我会话创建时空闲=90 天，但旧 renewSession 每次续期无条件把
// expires_at 写成 now+2h，登录后第一次续期就把 90 天截断成 2 小时 ——
// 用户关浏览器/部署完回来只要空闲 >2h 就莫名掉登录（哪怕勾了记住我）。
// 本文件锁住修复后的不变式。
/// <reference types="@cloudflare/vitest-pool-workers" />

import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { hashPassword } from '@pigeon-skin/auth';
import { LIMITS } from '@pigeon-skin/shared';
import { runMigrations } from './setup.ts';

const PASSWORD = 'renew-pass-9';
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Row {
  expires_at: number;
  absolute_expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

async function seedUser(): Promise<{ id: number; email: string }> {
  const email = `renew-${crypto.randomUUID()}@example.com`;
  const now = Date.now();
  const { id } = (await env.DB.prepare(
    "INSERT INTO users (email, nickname, password_hash, role, email_verified_at, created_at, updated_at) VALUES (?, 'renew user', ?, 'normal', ?, ?, ?) RETURNING id",
  ).bind(email, await hashPassword(PASSWORD), now, now, now).first<{ id: number }>())!;
  return { id, email };
}
async function login(email: string, keep: boolean): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await SELF.fetch('https://x/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ identifier: email, password: PASSWORD, keep }),
  });
  expect(res.status).toBe(200);
  return res.json();
}
async function activeSession(userId: number): Promise<Row> {
  const row = await env.DB.prepare(
    'SELECT expires_at, absolute_expires_at, last_seen_at, revoked_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
  ).bind(userId).first<Row>();
  if (!row) throw new Error('会话行不存在');
  return row;
}
/** 把会话 last_seen_at 拨到 16 分钟前，越过 15 分钟续期节流点，让下一次请求必触发 renewSession */
async function backdateLastSeen(userId: number): Promise<void> {
  await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(Date.now() - (LIMITS.sessionRenewIntervalSeconds + 60) * 1000, userId).run();
}
async function refresh(refreshToken: string): Promise<Response> {
  return SELF.fetch('https://x/api/v1/auth/refresh', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ refreshToken }),
  });
}

beforeAll(async () => { await runMigrations(); });

describe('滑动续期：只延长不缩短，绝对上限封顶', () => {
  it('记住我会话续期后仍保持 90 天空闲（不被打回 2 小时）', async () => {
    const u = await seedUser();
    const before = Date.now();
    const { refreshToken } = await login(u.email, true);
    const created = await activeSession(u.id);
    // 记住我创建即 90 天空闲
    expect(created.expires_at - before).toBeGreaterThan(89 * DAY);
    expect(created.absolute_expires_at - before).toBeGreaterThan(89 * DAY);

    await backdateLastSeen(u.id);
    expect((await refresh(refreshToken)).status).toBe(200);
    const renewed = await activeSession(u.id);
    // 续期刷新了 last_seen，且空闲没被截断（远大于 2 小时；修复前这里会变成 ~now+2h）
    expect(renewed.last_seen_at).toBeGreaterThanOrEqual(before);
    expect(renewed.expires_at - before).toBeGreaterThan(89 * DAY);
    expect(renewed.expires_at - renewed.last_seen_at).toBeGreaterThan(80 * DAY);
  });

  it('非记住会话续期后保持 2 小时空闲（行为不变）', async () => {
    const u = await seedUser();
    const { refreshToken } = await login(u.email, false);
    await backdateLastSeen(u.id);
    const before = Date.now();
    expect((await refresh(refreshToken)).status).toBe(200);
    const renewed = await activeSession(u.id);
    // 2 小时空闲 + 误差（now 在续期瞬间取）
    expect(renewed.expires_at - before).toBeGreaterThanOrEqual(2 * HOUR - 5_000);
    expect(renewed.expires_at - before).toBeLessThanOrEqual(2 * HOUR + 5_000);
  });

  it('空闲过期永不超过绝对上限（封顶）', async () => {
    const u = await seedUser();
    const { refreshToken } = await login(u.email, true);
    let row = await activeSession(u.id);
    // 人为制造 expires_at 高于绝对上限的异常态，续期应把它压回 absolute 之内
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .bind(row.absolute_expires_at + 10 * DAY, u.id).run();
    await backdateLastSeen(u.id);
    expect((await refresh(refreshToken)).status).toBe(200);
    const renewed = await activeSession(u.id);
    expect(renewed.expires_at).toBeLessThanOrEqual(renewed.absolute_expires_at);
  });

  it('续期节流：未到 15 分钟间隔不重写', async () => {
    const u = await seedUser();
    const { refreshToken } = await login(u.email, false);
    const first = await activeSession(u.id);
    // 不拨回 last_seen，直接再 refresh：距 last_seen < 15 分钟，跳过续期写入
    expect((await refresh(refreshToken)).status).toBe(200);
    const second = await activeSession(u.id);
    expect(second.last_seen_at).toBe(first.last_seen_at);
  });

  it('续期不复活已撤销的会话（WHERE 守卫）', async () => {
    const u = await seedUser();
    const { refreshToken } = await login(u.email, false);
    const first = await activeSession(u.id);
    // 直接撤销会话行，并把 last_seen_at 拨到节流点之外，
    // 让 renewSession 越过节流、真的执行 UPDATE —— 由 WHERE 守卫落空
    await env.DB.prepare('UPDATE sessions SET revoked_at = ?, last_seen_at = ? WHERE user_id = ?')
      .bind(Date.now(), Date.now() - (LIMITS.sessionRenewIntervalSeconds + 60) * 1000, u.id).run();
    expect((await refresh(refreshToken)).status).toBe(401);
    const renewed = await activeSession(u.id);
    expect(renewed.expires_at).toBe(first.expires_at);
    expect(renewed.last_seen_at - first.last_seen_at).toBeLessThan(LIMITS.sessionRenewIntervalSeconds * 1000);
  });
});

describe('无记住我勾选框的登录路径按记住会话签发', () => {
  // OAuth 换发（/auth/token）与账号初始化的同类断言分别在
  // oauth-social.test.ts / account-initialization.test.ts。
  it('注册自动登录的会话是记住会话（90 天空闲与绝对）', async () => {
    const before = Date.now();
    const email = `register-ttl-${crypto.randomUUID()}@example.com`;
    const res = await SELF.fetch('https://x/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({
        email, password: PASSWORD, nickname: 'register ttl',
        playerName: `regttl${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: number }>();
    const created = await activeSession(id);
    expect(created.expires_at - before).toBeGreaterThan(89 * DAY);
    expect(created.absolute_expires_at - before).toBeGreaterThan(89 * DAY);
  });
});
