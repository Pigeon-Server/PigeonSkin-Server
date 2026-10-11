// 测试环境初始化：应用迁移、提供直接写库的辅助函数。
//
// cloudflare:test 的 env 由 vitest-pool-workers 按 wrangler.jsonc 注入。
// 迁移 SQL 经虚拟模块 'virtual:db-migrations' 从 Node 侧传入
// （workerd 里没有文件系统）。
/// <reference types="@cloudflare/vitest-pool-workers" />

import { env, SELF } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    APP_URL: string;
    DB: D1Database;
    BUCKET: R2Bucket;
  }
}
// @ts-expect-error 虚拟模块由 vitest.config.ts 的插件提供
import { migrations } from 'virtual:db-migrations';

function splitSqlScript(script: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inTrigger = false;
  for (const rawLine of script.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('--')) continue;
    if (!inTrigger && /CREATE\s+TRIGGER/i.test(trimmed)) { inTrigger = true; current.push(rawLine); continue; }
    if (inTrigger && /^END\b/i.test(trimmed)) {
      inTrigger = false;
      current.push(rawLine);
      const stmt = current.join('\n').trim();
      if (stmt) out.push(stmt);
      current = [];
      continue;
    }
    if (inTrigger) { current.push(rawLine); continue; }
    current.push(rawLine);
    if (trimmed.endsWith(';')) {
      const stmt = current.join('\n').trim();
      if (stmt) out.push(stmt);
      current = [];
    }
  }
  const tail = current.join('\n').trim();
  if (tail) out.push(tail);
  return out;
}

/** 把迁移脚本应用到 miniflare 的 D1。幂等（表存在即跳过）。 */
export async function runMigrations(): Promise<void> {
  // isolatedStorage 每用例重置存储但复用 env.DB 对象；官方目录的完成态缓存按
  // DB 键缓存，不重置会让后续用例跳过初始化直接断言空表
  const { resetOfficialCatalogCache } = await import('../src/services/official-catalog.ts');
  resetOfficialCatalogCache(env.DB);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS test_migrations (name TEXT PRIMARY KEY)').run();
  for (const migration of migrations as Array<{ name: string; sql: string }>) {
    if (await env.DB.prepare('SELECT name FROM test_migrations WHERE name = ?').bind(migration.name).first()) continue;
    await env.DB.batch([
      ...splitSqlScript(migration.sql).map(stmt => env.DB.prepare(stmt)),
      env.DB.prepare('INSERT INTO test_migrations (name) VALUES (?)').bind(migration.name),
    ]);
  }
  // 测试环境无真实 AI 驱动语义依赖：默认关闭评论 AI 审核，评论用例直接落 published
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, locale, value, updated_at) VALUES ('comments_ai_moderation', '', 'false', 0)").run();
}


export async function markVerified(email: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET email_verified_at = ? WHERE email = ? COLLATE NOCASE`,
  ).bind(Date.now(), email).run();
}

export async function makeAdmin(userId: number): Promise<void> {
  await env.DB.prepare(`UPDATE users SET role = 'super_admin' WHERE id = ?`).bind(userId).run();
}

/** 造一枚明文已知的密码重置令牌（模拟"邮件已送达"） */
export async function mintRawToken(userId: number): Promise<string> {
  const raw = 'testtoken_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO password_reset_tokens (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
  ).bind(id, userId, now, now + 60 * 60 * 1000).run();
  return raw;
}

/** 塞一条"刚发过验证邮件"的记录，驱动邮件节流判定 */
export async function seedMailAttempt(identifier: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at)
     VALUES ('', ?, 'mail', 1, ?)`,
  ).bind(identifier, Date.now()).run();
}

export interface AuditRow {
  action: string;
  target_id: number | null;
  actor_id: number | null;
}

export async function readAudit(): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT action, target_id, actor_id FROM audit_log ORDER BY id`,
  ).all<AuditRow>();
  return results ?? [];
}

// ── Yggdrasil 签名测试密钥 ───────────────────────────────────────────────────

const TEST_KEY = globalThis as unknown as { __yggPem?: string; __yggPub?: CryptoKey };

export async function setTestYggKey(): Promise<void> {
  if (TEST_KEY.__yggPem) return;
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' },
    true, ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
  TEST_KEY.__yggPem = pem;
  TEST_KEY.__yggPub = kp.publicKey;
  // 必须走 admin 设置 API 写入：它调用 invalidateSettingsCache() 且与 SELF 同 isolate；
  // 直接写 D1 会被 60 秒设置缓存遮蔽（签名读到空串）。
  const reg = await SELF.fetch('https://x/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'yggkey-admin@example.com', password: 'correct-horse-9', playerName: 'yggkeyadmin' }),
  });
  const userId = await reg.json<{ id: number }>();
  await env.DB.prepare(`UPDATE users SET role = 'super_admin' WHERE id = ?`).bind(userId.id).run();
  const login = await SELF.fetch('https://x/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'yggkey-admin@example.com', password: 'correct-horse-9' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const patched = await SELF.fetch('https://x/api/v1/admin/settings', {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ settings: [{ key: 'ygg_private_key', value: pem }] }),
  });
  if (patched.status !== 200) throw new Error(`ygg_private_key 写入失败: ${patched.status}`);
}

export async function verifyTestYggSignature(value: string, signatureB64: string): Promise<boolean> {
  if (!TEST_KEY.__yggPub) return false;
  try {
    const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', TEST_KEY.__yggPub, sig, new TextEncoder().encode(value),
    );
  } catch {
    return false;
  }
}
