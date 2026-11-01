// 通行密钥登录 options 的按账号限定（Apple ID 式"输账号→继续"）：
// 带 identifier 时 allowCredentials 只含该账号的凭据；解析不到/无密钥/已合并
// 给空列表（浏览器抛 NotFoundError，前端据此回落密码登录）；不带 identifier
// 维持匿名 discovery（不传 allowCredentials 字段）。
/// <reference types="@cloudflare/vitest-pool-workers" />

import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { base64url } from 'jose';
import { createApp } from '../src/app.ts';
import { runMigrations } from './setup.ts';

const key = base64url.encode(new Uint8Array(32).fill(7));
const bindings = { ...env, APP_URL: 'https://x', MFA_ENCRYPTION_KEY: key } as typeof env;

async function user(email: string, playerName?: string): Promise<number> {
  const now = Date.now();
  const { id } = (await env.DB.prepare(
    "INSERT INTO users (email, nickname, password_hash, role, email_verified_at, created_at, updated_at) VALUES (?, ?, 'x', 'normal', ?, ?, ?) RETURNING id",
  ).bind(email, `pk-${crypto.randomUUID().slice(0, 8)}`, now, now, now).first<{ id: number }>())!;
  if (playerName) await env.DB.prepare('INSERT INTO players (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, playerName, now, now).run();
  return id;
}
async function addPasskey(userId: number, name: string): Promise<string> {
  const id = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, device_type, backed_up, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?)')
    .bind(id, userId, name, 'cose-fake', JSON.stringify(['internal']), 'unknown', Date.now()).run();
  return id;
}
async function options(body: Record<string, unknown>) {
  const response = await createApp().fetch(new Request('https://x/api/v1/auth/passkeys/options', {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body),
  }), bindings, undefined as never);
  expect(response.status).toBe(200);
  return await response.json<{ allowCredentials?: Array<{ id: string; transports: string[] }>; userVerification?: string }>();
}
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

beforeAll(async () => { await runMigrations(); });

describe('passkey login options allowCredentials', () => {
  it('resolves a real email to exactly that account\'s credentials', async () => {
    const email = `pk-real-${rand()}@example.com`;
    const a = await user(email);
    const b = await user(`pk-other-${rand()}@example.com`);
    const keyA1 = await addPasskey(a, 'Key A1');
    const keyA2 = await addPasskey(a, 'Key A2');
    const keyB = await addPasskey(b, 'Key B');
    const result = await options({ identifier: email.toUpperCase() });
    expect(result.allowCredentials?.map(c => c.id).sort()).toEqual([keyA1, keyA2].sort());
    expect(result.allowCredentials?.every(c => c.id !== keyB)).toBe(true);
  });

  it('resolves a player name to the account\'s credentials', async () => {
    const name = `PKPlayer${rand()}`;
    const a = await user(`pk-pn-${rand()}@example.com`, name);
    const keyA = await addPasskey(a, 'Key A');
    const result = await options({ identifier: name.toLowerCase() });
    expect(result.allowCredentials?.map(c => c.id)).toEqual([keyA]);
  });

  it('returns an empty list for an unknown email', async () => {
    const result = await options({ identifier: `nouser-${rand()}@example.com` });
    expect(result.allowCredentials).toEqual([]);
  });

  it('returns an empty list for an account without passkeys', async () => {
    const email = `pk-none-${rand()}@example.com`;
    await user(email);
    const result = await options({ identifier: email });
    expect(result.allowCredentials).toEqual([]);
  });

  it('returns an empty list for a merged account', async () => {
    const email = `pk-merged-${rand()}@example.com`;
    const a = await user(email);
    const b = await user(`pk-target-${rand()}@example.com`);
    await addPasskey(a, 'Key M');
    await env.DB.prepare('UPDATE users SET merged_into_user_id = ? WHERE id = ?').bind(b, a).run();
    const result = await options({ identifier: email });
    expect(result.allowCredentials).toEqual([]);
  });

  it('keeps discovery mode (no allowCredentials field) when identifier is absent', async () => {
    const result = await options({ remember: true });
    expect(result).not.toHaveProperty('allowCredentials');
    expect(result.userVerification).toBe('required');
  });
});
