// users 命令组：create / list / set-role / set-score / reset-password。
// 密码哈希必须走 @pigeon-skin/auth 的 hashPassword（pbkdf2 自描述格式），
// 与 API 登录校验共享同一实现；绝不在 CLI 内另造哈希。

import { randomBytes } from 'node:crypto';
import { hashPassword } from '@pigeon-skin/auth';
import type { TargetEnv } from '../lib/env.ts';
import { d1Query, d1ExecuteFile, type D1Row } from '../lib/wrangler.ts';
import { sqlText, normalizeEmail } from '../lib/sql.ts';
import { flagString, hasFlag, type ParsedArgs } from '../lib/args.ts';
import { assertApiKeyValued, resolveHttpChannel, adminRequest, expectOk, type HttpChannel } from './http-admin.ts';

const ROLES = ['super_admin', 'admin', 'normal', 'banned'] as const;
type Role = (typeof ROLES)[number];

const USER_COLUMNS = 'id, email, nickname, role, score, needs_initialization, created_at, last_sign_at';

function nowMs(): number {
  return Date.now();
}

/** 生成无歧义随机密码：去掉易混淆字符 */
function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += alphabet[b! % alphabet.length]!;
  return out;
}

interface UserRef { id: number; email: string; nickname: string; role: string; score: number | null }

function resolveUser(env: TargetEnv, flags: ReadonlyMap<string, string | true>): UserRef {
  const email = flagString(flags, 'email');
  const idText = flagString(flags, 'id');
  if (email === undefined && idText === undefined) {
    throw new Error('需要 --email <email> 或 --id <id> 定位用户');
  }
  if (email !== undefined && idText !== undefined) {
    throw new Error('--email 与 --id 只能提供一个');
  }
  // email 列是 COLLATE NOCASE，必须用 lower(email) = lower(?) 才能命中索引语义
  let row: D1Row | undefined;
  if (email !== undefined) {
    row = d1Query(env, `SELECT id, email, nickname, role, score FROM users WHERE lower(email) = ${sqlText(normalizeEmail(email).toLowerCase())}`)[0];
  } else {
    const id = Number(idText);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`--id 必须是正整数: ${idText}`);
    row = d1Query(env, `SELECT id, email, nickname, role, score FROM users WHERE id = ${id}`)[0];
  }
  if (!row || row.id === null) {
    throw new Error(email !== undefined ? `用户不存在: ${email}` : `用户不存在: id ${idText}`);
  }
  return {
    id: row.id as number,
    email: row.email as string,
    nickname: row.nickname as string,
    role: row.role as string,
    score: (row.score as number | null) ?? null,
  };
}

function parseRole(v: string | undefined): Role {
  if (v === undefined) return 'normal';
  if (!(ROLES as readonly string[]).includes(v)) {
    throw new Error(`--role 只支持 ${ROLES.join('|')}（收到 ${v}）`);
  }
  return v as Role;
}

function rowToUser(row: D1Row): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    role: row.role,
    score: row.score,
    needsInitialization: row.needs_initialization,
    createdAt: row.created_at,
    lastSignAt: row.last_sign_at,
  };
}

function requirePasswordInput(flags: ReadonlyMap<string, string | true>): { plain: string; generated: boolean } {
  const password = flagString(flags, 'password');
  const generate = hasFlag(flags, 'generate-password') || hasFlag(flags, 'generate');
  if (password === undefined && !generate) {
    throw new Error('需要 --password <明文> 或 --generate-password 生成随机密码');
  }
  if (password !== undefined && generate) {
    throw new Error('--password 与 --generate-password 只能提供一个');
  }
  const plain = password ?? generatePassword();
  if (plain.length < 8) throw new Error('密码至少 8 位');
  return { plain, generated: generate };
}

export async function runUsers(env: TargetEnv, action: string, parsed: ParsedArgs): Promise<number> {
  const { flags } = parsed;
  // HTTP 通道优先：--api-key 提供时走站点管理 API（admin.users.write scope）；
  // 缺省回落 wrangler 直写通道。裸 --api-key（无值）显式报错。
  assertApiKeyValued(flags);
  const channel = resolveHttpChannel(env, flags);
  switch (action) {
    case 'create': return channel ? usersCreateHttp(channel, flags) : usersCreate(env, flags);
    case 'list': return channel ? usersListHttp(channel, flags) : usersList(env, flags);
    case 'set-role': return channel ? usersSetFieldHttp(channel, flags, 'role') : usersSetRole(env, flags);
    case 'set-score': return channel ? usersSetFieldHttp(channel, flags, 'score') : usersSetScore(env, flags);
    case 'reset-password': return channel ? usersResetPasswordHttp(channel, flags) : usersResetPassword(env, flags);
    default:
      throw new Error(`未知 users 子命令 "${action}"（可用: create | list | set-role | set-score | reset-password）`);
  }
}

// ── HTTP 通道（scope: admin.users.write）────────────────────────────────────

/** 用 q 参数按 email 精确定位用户（服务端 q 是子串匹配，per_page 拉满 100 再精确比对） */
async function findUserIdHttp(channel: HttpChannel, email: string): Promise<number> {
  const result = await adminRequest(channel, 'GET', `/api/v1/pigeon/admin/users?q=${encodeURIComponent(email)}&per_page=100`);
  const items = (expectOk(result, '查找用户').items ?? []) as { id: number; email: string }[];
  const hit = items.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!hit) throw new Error(`用户不存在: ${email}`);
  return hit.id;
}

async function usersCreateHttp(channel: HttpChannel, flags: ReadonlyMap<string, string | true>): Promise<number> {
  const email = normalizeEmail(flagString(flags, 'email') ?? '');
  const nickname = flagString(flags, 'nickname') ?? '';
  const role = parseRole(flagString(flags, 'role'));
  const { plain, generated } = requirePasswordInput(flags);

  const result = await adminRequest(channel, 'POST', '/api/v1/pigeon/admin/users', {
    email, nickname, password: plain, role,
  });
  const body = expectOk(result, '创建用户');
  console.log(`已通过管理 API 创建用户（id ${body.id}）:`);
  console.log(`  email:    ${email}`);
  console.log(`  nickname: ${nickname || '（空）'}`);
  console.log(`  role:     ${role}`);
  console.log('  score:    0（HTTP 通道不应用 initial_score，可用 users set-score 调整）');
  if (generated) {
    console.log(`  password: ${plain}（仅本次显示，请立即保存）`);
  }
  return 0;
}

async function usersListHttp(channel: HttpChannel, flags: ReadonlyMap<string, string | true>): Promise<number> {
  const search = flagString(flags, 'search');
  const page = await adminRequest(channel, 'GET', `/api/v1/pigeon/admin/users${search ? `?q=${encodeURIComponent(search)}` : ''}`);
  const body = expectOk(page, '查询用户');
  const items = (body.items ?? []) as { id: number; email: string; nickname: string; role: string; score: number }[];
  if (hasFlag(flags, 'json')) {
    console.log(JSON.stringify(items, null, 2));
    return 0;
  }
  if (items.length === 0) { console.log('无用户'); return 0; }
  console.log(`共 ${items.length} 行（服务端分页）:`);
  for (const u of items) {
    console.log(`  #${u.id}  ${u.email}  ${u.nickname || '—'}  ${u.role}  score=${u.score}`);
  }
  return 0;
}

async function usersSetFieldHttp(
  channel: HttpChannel,
  flags: ReadonlyMap<string, string | true>,
  field: 'role' | 'score',
): Promise<number> {
  const user = await resolveUserHttp(channel, flags);
  let patch: { role?: string; score?: number };
  if (field === 'role') {
    patch = { role: parseRole(flagString(flags, 'role')) };
  } else {
    const scoreText = flagString(flags, 'score');
    if (scoreText === undefined) throw new Error('需要 --score <整数>');
    const score = Number(scoreText);
    if (!Number.isSafeInteger(score) || score < 0) throw new Error('--score 必须是非负整数');
    patch = { score };
  }
  await adminRequest(channel, 'PATCH', `/api/v1/pigeon/admin/users/${user.id}`, patch);
  const applied = field === 'role' ? patch.role : patch.score;
  console.log(`用户 #${user.id}（${user.email}）已更新: ${field}=${applied}`);
  return 0;
}

async function usersResetPasswordHttp(channel: HttpChannel, flags: ReadonlyMap<string, string | true>): Promise<number> {
  const user = await resolveUserHttp(channel, flags);
  // HTTP 通道由服务端生成临时密码（resetUserPassword），CLI 不传明文
  const hasPassword = flagString(flags, 'password') !== undefined || hasFlag(flags, 'generate-password') || hasFlag(flags, 'generate');
  if (hasPassword) {
    throw new Error('HTTP 通道不支持指定密码：服务端生成临时密码。要指定明文请去掉 --api-key 走 wrangler 通道');
  }
  const result = await adminRequest(channel, 'POST', `/api/v1/pigeon/admin/users/${user.id}/reset-password`);
  const body = expectOk(result, '重置密码');
  console.log(`用户 #${user.id}（${user.email}）密码已重置。`);
  console.log(`  password: ${body.temporaryPassword}（仅本次显示，请立即保存）`);
  return 0;
}

/** HTTP 通道下的用户定位：--id 直用；--email 先查后取 id */
async function resolveUserHttp(channel: HttpChannel, flags: ReadonlyMap<string, string | true>): Promise<{ id: number; email: string }> {
  const email = flagString(flags, 'email');
  const idText = flagString(flags, 'id');
  if (email !== undefined && idText !== undefined) throw new Error('--email 与 --id 只能提供一个');
  if (idText !== undefined) {
    const id = Number(idText);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`--id 必须是正整数: ${idText}`);
    return { id, email: `id:${id}` };
  }
  if (email === undefined) throw new Error('需要 --email <email> 或 --id <id> 定位用户');
  const id = await findUserIdHttp(channel, normalizeEmail(email));
  return { id, email: normalizeEmail(email) };
}

async function usersCreate(env: TargetEnv, flags: ReadonlyMap<string, string | true>): Promise<number> {
  const email = normalizeEmail(flagString(flags, 'email') ?? '');
  const nickname = flagString(flags, 'nickname') ?? '';
  const role = parseRole(flagString(flags, 'role'));
  const { plain, generated } = requirePasswordInput(flags);

  const existing = d1Query(env, `SELECT id FROM users WHERE lower(email) = ${sqlText(email.toLowerCase())}`);
  if (existing.length > 0) throw new Error(`邮箱已存在: ${email}`);

  const passwordHash = await hashPassword(plain);
  const ts = nowMs();
  d1ExecuteFile(env, [
    `INSERT INTO users (email, nickname, score, password_hash, role, created_at, updated_at) `
      + `VALUES (${sqlText(email)}, ${sqlText(nickname)}, 1000, ${sqlText(passwordHash)}, ${sqlText(role)}, ${ts}, ${ts})`,
  ]);
  console.log(`已在 ${env.label} 创建用户:`);
  console.log(`  email:    ${email}`);
  console.log(`  nickname: ${nickname || '（空）'}`);
  console.log(`  role:     ${role}`);
  console.log('  score:    1000（固定初值，可用 users set-score 调整）');
  if (generated) {
    console.log(`  password: ${plain}（仅本次显示，请立即保存）`);
  }
  return 0;
}

function usersList(env: TargetEnv, flags: ReadonlyMap<string, string | true>): number {
  const search = flagString(flags, 'search');
  // LIKE 通配符 % 和 _ 都转义为字面量（ESCAPE '\'），搜索词按普通文本匹配
  const kw = search !== undefined
    ? search.trim().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
    : undefined;
  const where = kw
    ? `WHERE email LIKE ${sqlText(`%${kw}%`)} ESCAPE '\\' OR nickname LIKE ${sqlText(`%${kw}%`)} ESCAPE '\\'`
    : '';
  const rows = d1Query(env, `SELECT ${USER_COLUMNS} FROM users ${where} ORDER BY id LIMIT 500`);
  if (hasFlag(flags, 'json')) {
    console.log(JSON.stringify(rows.map(rowToUser), null, 2));
    return 0;
  }
  if (rows.length === 0) { console.log('无用户'); return 0; }
  console.log(`共 ${rows.length} 行（上限 500）:`);
  for (const r of rows) {
    console.log(`  #${r.id}  ${r.email}  ${r.nickname || '—'}  ${r.role}  score=${r.score}`);
  }
  return 0;
}

function usersSetRole(env: TargetEnv, flags: ReadonlyMap<string, string | true>): number {
  const role = parseRole(flagString(flags, 'role'));
  const user = resolveUser(env, flags);
  if (user.role === role) { console.log(`用户 #${user.id} 已是 ${role}，无需变更`); return 0; }
  d1ExecuteFile(env, [
    `UPDATE users SET role = ${sqlText(role)}, updated_at = ${nowMs()} WHERE id = ${user.id}`,
  ]);
  console.log(`用户 #${user.id}（${user.email}）: ${user.role} → ${role}`);
  return 0;
}

function usersSetScore(env: TargetEnv, flags: ReadonlyMap<string, string | true>): number {
  const scoreText = flagString(flags, 'score');
  if (scoreText === undefined) throw new Error('需要 --score <整数>');
  const score = Number(scoreText);
  if (!Number.isSafeInteger(score) || score < 0) throw new Error('--score 必须是非负整数');
  const user = resolveUser(env, flags);
  d1ExecuteFile(env, [
    `UPDATE users SET score = ${score}, updated_at = ${nowMs()} WHERE id = ${user.id}`,
  ]);
  console.log(`用户 #${user.id}（${user.email}）score: ${user.score ?? '?'} → ${score}`);
  return 0;
}

async function usersResetPassword(env: TargetEnv, flags: ReadonlyMap<string, string | true>): Promise<number> {
  const user = resolveUser(env, flags);
  const { plain } = requirePasswordInput(flags);
  const passwordHash = await hashPassword(plain);
  d1ExecuteFile(env, [
    `UPDATE users SET password_hash = ${sqlText(passwordHash)}, password_rehash_required = 0, updated_at = ${nowMs()} WHERE id = ${user.id}`,
  ]);
  console.log(`用户 #${user.id}（${user.email}）密码已重置。`);
  console.log(`  password: ${plain}（仅本次显示，请立即保存）`);
  return 0;
}
