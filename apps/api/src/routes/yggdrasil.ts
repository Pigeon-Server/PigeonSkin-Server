import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  createDb, mojangVerifications, players, textures, users, uuidMap, yggLog, yggTokens,
} from '@pigeon-skin/db';
import { verifyStoredPassword, hashToken, hashPassword } from '@pigeon-skin/auth';
import { getSetting, getSettingBool, getSettingInt, needsAccountInitialization, type AppEnv } from '../lib.ts';
import { verifyConnectToken } from '../services/connect.ts';
import { gameProfiles, uuidForPlayer, publicProfile, userUuid, type GameProfile } from '../services/ygg-profiles.ts';
import { inspectSigningKey, privateKeyBytes } from '../services/ygg-key.ts';
import { issueYggToken, readYggToken, rotateYggToken } from '../services/ygg-tokens.ts';

type Ctx = Context<AppEnv>;

// ── 协议错误形态（字节级契约）─────────────────────────────────────────────────

class ForbiddenOperation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenOperation';
  }
}

class IllegalArgument extends Error {}

function forbidden(message: string): ForbiddenOperation {
  return new ForbiddenOperation(message);
}

async function throttle(c: Ctx, username: string) {
  const gap = await getSettingInt(c.env, 'ygg_rate_limit');
  if (!gap) return;
  const identifier = await hashToken(username.toLowerCase());
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const result = await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at) SELECT ?, 'ip', 'ygg-ip', 0, ? WHERE NOT EXISTS (SELECT 1 FROM auth_attempts WHERE ip = ? AND kind = 'ygg-ip' AND created_at > ?) RETURNING id")
      .bind(ip, now, ip, now - gap),
    c.env.DB.prepare("INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at) SELECT ?, ?, 'ygg', 1, ? WHERE changes()>0 AND NOT EXISTS (SELECT 1 FROM auth_attempts WHERE identifier = ? AND kind = 'ygg' AND created_at > ?) RETURNING id")
      .bind(ip, identifier, now, identifier, now - gap),
  ]);
  if (!result[0]?.meta.changes || !result[1]?.meta.changes) throw forbidden('Too many requests. Please try again later.');
}

// ── 材质 profile 序列化（字节级契约）─────────────────────────────────────────

interface TextureInfo { url: string; metadata?: { model: string } }

async function profilePayload(
  c: Ctx,
  p: { uuid: string; name: string; skinHash: string | null; skinModel: string | null; capeHash: string | null },
): Promise<Record<string, unknown>> {
  const appUrl = c.env.APP_URL.replace(/\/$/, '');
  const texturesBody: Record<string, TextureInfo> = {};
  if (p.skinHash) {
    texturesBody.SKIN = {
      url: `${appUrl}/textures/${p.skinHash}`,
      ...(p.skinModel === 'slim' ? { metadata: { model: 'slim' } } : {}),
    };
  }
  if (p.capeHash) {
    texturesBody.CAPE = { url: `${appUrl}/textures/${p.capeHash}` };
  }

  const valueObj = {
    timestamp: Date.now(),
    profileId: p.uuid,
    profileName: p.name,
    isPublic: true,
    textures: texturesBody,
  };
  // btoa 只接受 Latin-1：角色名支持 CJK/UTF8 规则，必须先转 UTF-8 字节
  const value = btoaUtf8(JSON.stringify(valueObj));

  const properties: Array<{ name: string; value: string }> = [
    { name: 'textures', value },
    // uploadableTextures：游戏内上传能力标记（原插件行为）
    { name: 'uploadableTextures', value: 'skin,cape' },
  ];

  return { id: p.uuid, name: p.name, properties };
}

/** UTF-8 安全的 btoa（btoa 原生只接受 Latin-1） */
function btoaUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function signPayload(c: Ctx, payload: string): Promise<string | null> {
  const pem = await getSetting(c.env, 'ygg_private_key');
  if (!pem) throw forbidden('Signing key is not configured.');
  try {
    const keyData = privateKeyBytes(pem);
    const key = await crypto.subtle.importKey(
      'pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  } catch (e) {
    console.error('材质签名失败:', e instanceof Error ? e.message : String(e));
    throw forbidden('Invalid signing key.');
  }
}


/** 组装完整带签 profile 响应。
 * 签名对象是 textures property 的 **value 字符串本身**（Mojang/authlib-injector 契约：
 * 验证方拿 property.value 去验签，不是整个 profile body）。
 * Mojang 正版回退的 profile 自带官方签名，调用方必须绕开本函数原样透传。 */
async function signedProfileResponse(c: Ctx, profile: Record<string, unknown>, unsigned: boolean): Promise<Response> {
  if (unsigned) {
    return c.body(JSON.stringify(profile), 200, { 'Content-Type': 'application/json; charset=utf-8' });
  }
  // **先签名、后序列化** —— 先 stringify 再 mutate 对象的话，
  // 响应体里永远不会有 signature（Round 1 修复轮实测踩中的时序坑）
  const props = profile.properties as Array<{ name: string; value: string; signature?: string }> | undefined;
  for (const prop of props ?? []) {
    if (prop.name === 'textures') {
      const body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(prop.value), char => char.charCodeAt(0))));
      body.signatureRequired = true;
      prop.value = btoaUtf8(JSON.stringify(body));
    }
    const signature = await signPayload(c, prop.value);
    if (signature) prop.signature = signature;
  }
  return c.body(JSON.stringify(profile), 200, { 'Content-Type': 'application/json; charset=utf-8' });
}

// ── 用户/玩家查找 ────────────────────────────────────────────────────────────

async function profilesOf(c: Ctx, userId: number) { return gameProfiles(c, userId); }
async function uuidFor(c: Ctx, name: string): Promise<string> {
  const p = await c.env.DB.prepare('SELECT id FROM players WHERE name = ? COLLATE NOCASE').bind(name).first<{ id: number }>();
  if (!p) throw forbidden('The player does not exist.');
  return (await uuidForPlayer(c, p.id)).id;
}

async function logYgg(c: Ctx, action: string, body?: string, userId: number | null = null, playerId: number | null = null): Promise<void> {
  try {
    await createDb(c.env.DB).insert(yggLog).values({
      ip: c.req.header('cf-connecting-ip') ?? null,
      action,
      body: body ?? null,
      userId,
      playerId,
      createdAt: Date.now(),
    });
  } catch { /* 日志失败不影响主流程 */ }
}

async function requireToken(c: Ctx, accessToken: string, clientToken?: string, refresh = false, requiredScope?: string): Promise<{ userId: number; profile: GameProfile | null; source: string; clientToken: string; tokenId: string }> {
  const row = await readYggToken(c.env.DB, accessToken, refresh);
  if (!row) throw forbidden('Invalid token.');
  const user = await c.env.DB.prepare('SELECT role, email, password_hash, needs_initialization, email_verified_at FROM users WHERE id = ?').bind(row.user_id).first<{ role: string; email: string; password_hash: string; needs_initialization: number; email_verified_at: number | null }>();
  if (!user || user.role === 'banned' || (await getSettingBool(c.env, 'require_email_verification') && !user.email_verified_at)) throw forbidden('Invalid token.');
  if (needsAccountInitialization(user.email, user.password_hash, user.needs_initialization)) throw forbidden('Invalid token.');
  if (row.source === 'connect') {
    if (refresh) throw forbidden('Use the Connect token endpoint to refresh this token.');
    try { await verifyConnectToken(c, accessToken, requiredScope || 'Yggdrasil.Server.Join'); } catch { throw forbidden('Invalid token.'); }
  }
  if (clientToken !== undefined && clientToken !== row.client_token) throw forbidden('Invalid client token.');
  let profile: GameProfile | null = null;
  if (row.player_id !== null) {
    const p = await c.env.DB.prepare('SELECT u.uuid AS id, u.name, u.player_id AS playerId, u.version FROM uuid u JOIN players p ON p.id = u.player_id WHERE u.player_id = ? AND p.user_id = ?').bind(row.player_id, row.user_id).first<GameProfile>();
    if (!p || p.id !== row.profile_uuid || (!refresh && p.version !== row.profile_version)) throw forbidden('Invalid token.');
    profile = p;
  } else if (!refresh) throw forbidden('No selected profile.');
  return { userId: row.user_id, profile, source: row.source, clientToken: row.client_token, tokenId: row.id };
}

async function readJsonBody(c: Ctx): Promise<Record<string, unknown>> {
  const ct = c.req.header('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new IllegalArgument('ContentType not application/json');
  }
  const body = await c.req.json<unknown>().catch(() => {
    throw new IllegalArgument('Invalid JSON body');
  });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IllegalArgument('Invalid JSON body');
  const record = body as Record<string, unknown>;
  for (const key of ['username', 'password', 'clientToken', 'accessToken', 'serverId']) {
    if (record[key] !== undefined && typeof record[key] !== 'string') throw new IllegalArgument(`Invalid ${key}.`);
  }
  if (record.requestUser !== undefined && typeof record.requestUser !== 'boolean') throw new IllegalArgument('Invalid requestUser.');
  return body as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

export function registerYggdrasilRoutes(app: Hono<AppEnv>): void {
  const r = new Hono<AppEnv>();

  // ForbiddenOperationException 的协议错误形态（{"errorMessage": "..."}，403）。
  // 子应用 onError 先于全局 onError 执行。
  r.onError((err, c) => {
    if (err instanceof IllegalArgument) return c.json({ error: 'IllegalArgumentException', errorMessage: err.message }, 400);
    if (err instanceof ForbiddenOperation) {
      return c.json({ error: 'ForbiddenOperationException', errorMessage: err.message }, 403);
    }
    throw err;
  });

  r.use('/authserver/*', async (c, next) => {
    if (await getSettingBool(c.env, 'ygg_disable_authserver')) throw forbidden('Traditional authentication is disabled.');
    await next();
  });

  // 元信息（authlib-injector 的 API 入口；feature.non_email_login 照原插件）
  const metadata = async (c: Ctx) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.notFound();
    const siteName = await getSetting(c.env, 'site_name');
    const skinDomains = [...new Set([new URL(c.env.APP_URL).hostname, ...(await getSetting(c.env, 'ygg_skin_domain')).split(',').map((d) => d.trim()).filter(Boolean)])];
    const pem = await getSetting(c.env, 'ygg_private_key');
    const publicKey = (await inspectSigningKey(pem)).publicKey;
    const body: Record<string, unknown> = {
      skinDomains: skinDomains.length > 0 ? skinDomains : [new URL(c.env.APP_URL).hostname],
      // 未配置私钥时省略字段（空串会让 authlib-injector 解析报错，原插件行为是不下发）
      ...(publicKey ? { signaturePublickey: publicKey } : {}),
      meta: {
        serverName: siteName,
        implementationName: 'Yggdrasil API for Pigeon Skin Server',
        implementationVersion: '7.0.0',
        links: { homepage: c.env.APP_URL, ...(await getSettingBool(c.env, 'registration_enabled') ? { register: `${c.env.APP_URL}/auth/register` } : {}) },
        ...(!(await getSettingBool(c.env, 'ygg_disable_authserver')) ? { 'feature.non_email_login': true } : {}),
        ...(await getSettingBool(c.env, 'ygg_connect_enabled') ? { 'feature.openid_configuration_url': `${c.env.APP_URL.replace(/\/$/, '')}/yggc/.well-known/openid-configuration` } : {}),
      },
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (await getSettingBool(c.env, 'ygg_enable_ali')) {
      headers['X-Authlib-Injector-API-Location'] = `${c.env.APP_URL.replace(/\/$/, '')}/api/yggdrasil`;
    }
    return c.body(JSON.stringify(body), 200, headers);
  };
  r.all('/', metadata);
  app.get('/api/yggdrasil/', metadata);

  // ── authserver ─────────────────────────────────────────────────────────────

  r.post('/authserver/authenticate', async (c) => {
    const body = await readJsonBody(c);
    const username = str(body, 'username');
    const password = str(body, 'password');
    const clientToken = str(body, 'clientToken') || crypto.randomUUID().replace(/-/g, '');
    const requestUser = body.requestUser === true;
    if (!username || !password) throw new IllegalArgument('Credentials are required.');

    await throttle(c, username);

    const db = createDb(c.env.DB);
    const user = username.includes('@')
      ? (await db.select({ id: users.id, email: users.email, nickname: users.nickname, role: users.role, emailVerifiedAt: users.emailVerifiedAt, passwordHash: users.passwordHash, needsInitialization: users.needsInitialization })
          .from(users).where(sql`${users.email} = ${username} COLLATE NOCASE AND ${users.mergedIntoUserId} IS NULL`).limit(1))[0]
      : (await db.select({ id: users.id, email: users.email, nickname: users.nickname, role: users.role, emailVerifiedAt: users.emailVerifiedAt, passwordHash: users.passwordHash, needsInitialization: users.needsInitialization })
          .from(players).innerJoin(users, eq(users.id, players.userId))
          .where(sql`${players.name} = ${username} COLLATE NOCASE`).limit(1))[0];

    // 不存在也做等价哈希（与主站登录同一防时序策略）
    const loggedUsername = username.includes('@') ? username.replace(/^(.{1,2}).*(@.*)$/, '$1***$2') : username;
    await logYgg(c, 'authenticate', loggedUsername, user?.id ?? null);
    const ok = user === undefined
      ? (await verifyStoredPassword(password, await hashPassword('timing-equalizer'), { legacySalt: c.env.LEGACY_SALT ?? '' }), false)
      : await verifyStoredPassword(password, user.passwordHash, { legacySalt: c.env.LEGACY_SALT ?? '' });
    if (!ok || !user) throw forbidden('Invalid credentials. Invalid username or password.');

    if (user.role === 'banned') throw forbidden('This account is banned.');
    const conflicts = await db.select({ id: users.id }).from(users).where(sql`${users.email} = ${user.email} COLLATE NOCASE AND ${users.legacyEmailConflict} = 1 AND ${users.mergedIntoUserId} IS NULL`).limit(2);
    if (conflicts.length > 1) throw forbidden('Resolve the legacy email conflict on the website before signing in.');
    if (needsAccountInitialization(user.email, user.passwordHash, user.needsInitialization)) throw forbidden('Account initialization required.');
    if (await getSettingBool(c.env, 'require_email_verification') && !user.emailVerifiedAt) throw forbidden('Email is not verified.');

    const profiles = await profilesOf(c, user.id);
    if (profiles.length === 0) throw forbidden('The player does not exist.');

    // 单用户令牌上限（ygg_tokens_limit）
    const limit = await getSettingInt(c.env, 'ygg_tokens_limit');
    const countRows = await db.select({ n: sql<number>`count(*)` })
      .from(yggTokens).where(and(eq(yggTokens.userId, user.id), eq(yggTokens.source, 'traditional')));
    if ((countRows[0]?.n ?? 0) >= limit) {
      // 淘汰最老的令牌
      const oldest = await db.select({ id: yggTokens.id })
        .from(yggTokens).where(and(eq(yggTokens.userId, user.id), eq(yggTokens.source, 'traditional')))
        .orderBy(yggTokens.createdAt).limit(1);
      if (oldest[0]) await db.delete(yggTokens).where(eq(yggTokens.id, oldest[0].id));
    }

    const selected = profiles.length === 1 ? profiles[0] : (!username.includes('@') ? profiles.find(p => p.name.toLowerCase() === username.toLowerCase()) : undefined);
    const accessToken = await issueToken(c, user.id, clientToken, selected ?? null);
    const resp: Record<string, unknown> = {
      accessToken,
      clientToken,
      // 规范语义：availableProfiles 恒为该用户全部角色（启动器靠它做切换列表）；
      // selectedProfile 单独指向本次绑定的角色
      availableProfiles: profiles.map(publicProfile),
    };
    if (selected) resp.selectedProfile = publicProfile(selected);
    if (requestUser) {
      resp.user = { id: await userUuid(user.id), properties: [] };
    }
    return c.json(resp);
  });

  r.post('/authserver/refresh', async (c) => {
    const body = await readJsonBody(c);
    const accessToken = str(body, 'accessToken');
    const clientToken = str(body, 'clientToken');
    const token = await requireToken(c, accessToken, clientToken || undefined, true);
    const profiles = await profilesOf(c, token.userId);
    const requested = body.selectedProfile as { id?: string; name?: string } | undefined;
    if (requested && (typeof requested.id !== 'string' || typeof requested.name !== 'string')) throw new IllegalArgument('Invalid selected profile.');
    if (token.profile && requested && token.profile.id !== requested.id) throw forbidden('Access token already has a profile assigned.');
    // 规范：selectedProfile 可选——原令牌已绑定则保持；未绑定且请求未指定时
    // 直接轮换出一个同样未绑定的令牌（响应省略 selectedProfile），不得拒绝。
    const selected = token.profile ?? (requested ? profiles.find(p => p.id === requested.id) : null);
    if (requested && !selected) throw new IllegalArgument('Invalid selected profile.');
    if (!token.profile && requested && !profiles.some(p => p.id === requested.id)) throw forbidden('Invalid profile.');
    const newClientToken = clientToken || token.clientToken;
    const newAccessToken = await rotateYggToken(c.env.DB, accessToken, await tokenInput(c, token.userId, newClientToken, selected ?? null));
    if (!newAccessToken) throw forbidden('Invalid token.');
    await logYgg(c, 'refresh', undefined, token.userId, selected?.playerId ?? null);
    const resp: Record<string, unknown> = {
      accessToken: newAccessToken,
      clientToken: newClientToken,
      availableProfiles: profiles.map(publicProfile),
    };
    if (selected) resp.selectedProfile = publicProfile(selected);
    if (body.requestUser === true) resp.user = { id: await userUuid(token.userId), properties: [] };
    return c.json(resp);
  });

  r.post('/authserver/validate', async (c) => {
    const body = await readJsonBody(c);
    await requireToken(c, str(body, 'accessToken'), str(body, 'clientToken') || undefined);
    return c.body(null, 204);
  });

  r.post('/authserver/invalidate', async (c) => {
    const body = await readJsonBody(c);
    const accessToken = str(body, 'accessToken');
    if (accessToken) {
      await createDb(c.env.DB).delete(yggTokens).where(eq(yggTokens.id, await hashToken(accessToken)));
    }
    return c.body(null, 204);
  });

  r.post('/authserver/signout', async (c) => {
    const body = await readJsonBody(c);
    const username = str(body, 'username');
    const password = str(body, 'password');
    if (!username || !password) throw new IllegalArgument('Credentials are required.');
    await throttle(c, username);

    const db = createDb(c.env.DB);
    const user = username.includes('@')
      ? (await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(sql`${users.email} = ${username} COLLATE NOCASE`).limit(1))[0]
      : (await db.select({ id: users.id, passwordHash: users.passwordHash }).from(players).innerJoin(users, eq(users.id, players.userId)).where(sql`${players.name} = ${username} COLLATE NOCASE`).limit(1))[0];
    const ok = user
      ? await verifyStoredPassword(password, user.passwordHash, { legacySalt: c.env.LEGACY_SALT ?? '' })
      : false;
    await logYgg(c, 'signout', username, user?.id ?? null);
    if (!user || !ok) return c.body(null, 204);

    await db.delete(yggTokens).where(and(eq(yggTokens.userId, user.id), eq(yggTokens.source, 'traditional')));
    return c.body(null, 204);
  });

  // ── sessionserver ──────────────────────────────────────────────────────────

  r.post('/sessionserver/session/minecraft/join', async (c) => {
    const body = await readJsonBody(c);
    const accessToken = str(body, 'accessToken');
    const selectedProfile = str(body, 'selectedProfile');
    const serverId = str(body, 'serverId');
    if (!accessToken || !selectedProfile || !serverId) throw new IllegalArgument('Credentials are required.');

    const { userId, profile } = await requireToken(c, accessToken);
    if (!profile || profile.id !== selectedProfile) throw forbidden('Invalid profile.');
    await c.env.DB.prepare('INSERT INTO ygg_sessions (server_hash, player_id, profile_uuid, profile_version, token_id, ip, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(server_hash, player_id) DO UPDATE SET profile_uuid = excluded.profile_uuid, profile_version = excluded.profile_version, token_id = excluded.token_id, ip = excluded.ip, expires_at = excluded.expires_at')
      .bind(await hashToken(serverId), profile.playerId, profile.id, profile.version, await hashToken(accessToken), c.req.header('cf-connecting-ip') ?? '', Date.now() + 120000).run();
    await logYgg(c, 'join', selectedProfile, userId, profile.playerId);
    return c.body(null, 204);
  });

  r.get('/sessionserver/session/minecraft/hasJoined', async (c) => {
    const username = c.req.query('username') ?? '';
    const serverId = c.req.query('serverId') ?? '';
    const ip = c.req.query('ip');
    if (!username || !serverId) return c.body(null, 204);

    const join = await c.env.DB.prepare("SELECT u.uuid AS id, p.name, s.ip FROM ygg_sessions s JOIN uuid u ON u.player_id = s.player_id JOIN players p ON p.id = s.player_id JOIN users a ON a.id = p.user_id JOIN ygg_tokens t ON t.id = s.token_id WHERE s.server_hash = ? AND p.name = ? COLLATE NOCASE AND s.expires_at > ? AND t.expires_at > ? AND u.uuid = s.profile_uuid AND u.version = s.profile_version AND a.role != 'banned'")
      .bind(await hashToken(serverId), username, Date.now(), Date.now()).first<{ id: string; name: string; ip: string }>();
    if (!join || (ip && ip !== join.ip)) return c.body(null, 204);
    const profile = await fullProfile(c, join.id, join.name);
    if (!profile) return c.body(null, 204);
    // Mojang 正版回退：官方签名原样透传（与 profile/:uuid 裁定一致）
    if ((profile as { __mojang?: boolean }).__mojang === true) {
      delete (profile as { __mojang?: boolean }).__mojang;
      return c.body(JSON.stringify(profile), 200, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    // hasJoined 必须带签（服主验票）—— 与 profile/:uuid 共用同一签名路径
    return signedProfileResponse(c, profile, false);
  });

  r.get('/sessionserver/session/minecraft/profile/:uuid', async (c) => {
    const unsigned = c.req.query('unsigned') !== 'false';
    // 容忍带连字符/大写的 uuid（normalize 更稳）
    const normalized = (c.req.param('uuid') ?? '').toLowerCase().replace(/-/g, '');
    const uuid = /^[0-9a-f]{32}$/.test(normalized) ? normalized : (c.req.param('uuid') ?? '');
    const [row] = await createDb(c.env.DB)
      .select({ name: uuidMap.name })
      .from(uuidMap).where(eq(uuidMap.uuid, uuid)).limit(1);
    if (!row) return c.body(null, 204);
    const profile = await fullProfile(c, uuid, row.name);
    if (!profile) return c.body(null, 204);
    // fullProfile 返回 mojangProfile 标记时：Mojang 官方签名已在其 properties 里，原样透传
    if ((profile as { __mojang?: boolean }).__mojang === true) {
      delete (profile as { __mojang?: boolean }).__mojang;
      return c.body(JSON.stringify(profile), 200, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    return signedProfileResponse(c, profile, unsigned);
  });

  // ── API 查询 / 上传 ────────────────────────────────────────────────────────

  r.post('/api/profiles/minecraft', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: 'IllegalArgumentException', errorMessage: 'Invalid request body.' }, 413) }), async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    if (!Array.isArray(body) || body.some(name => typeof name !== 'string')) throw new IllegalArgument('Invalid request body.');
    const names = [...new Set(body.map(String))];
    const max = await getSettingInt(c.env, 'ygg_search_profile_max');
    if (names.length > max) {
      throw forbidden(`Cannot search more than ${max} profiles at a time.`);
    }
    const db = createDb(c.env.DB);
    const out: Array<{ id: string; name: string }> = [];
    for (const name of names) {
      // 语义照原插件：直接查 players 表（不是 uuid 缓存表）——
      // 未认证过的角色也能查到
      const [row] = await db.select({ name: players.name })
        .from(players).where(sql`${players.name} = ${name} COLLATE NOCASE`).limit(1);
      if (row) out.push({ id: await uuidFor(c, row.name), name: row.name });
    }
    return c.json(out);
  });

  r.get('/api/users/profiles/minecraft/:username', async (c) => {
    const name = c.req.param('username') ?? '';
    const [row] = await createDb(c.env.DB)
      .select({ name: players.name })
      .from(players).where(sql`${players.name} = ${name} COLLATE NOCASE`).limit(1);
    if (!row) return c.body(null, 204);
    return c.json({ id: await uuidFor(c, row.name), name: row.name });
  });

  // 游戏内上传/清除材质（Bearer accessToken）
  r.put('/api/user/profile/:uuid/:type', bodyLimit({ maxSize: 101 * 1024 * 1024, onError: c => c.json({ error: 'IllegalArgumentException', errorMessage: 'File is too large.' }, 413) }), async (c) => {
    const user = await requireBearer(c, 'Yggdrasil.PlayerProfiles.Upload');
    const maxBytes = (await getSettingInt(c.env, 'max_upload_size_kb')) * 1024;
    const rawLength = c.req.header('content-length');
    if (rawLength !== undefined && (!/^\d+$/.test(rawLength) || Number(rawLength) > maxBytes + 256 * 1024)) return c.body(null, 413);
    const uuid = c.req.param('uuid') ?? '';
    const type = c.req.param('type') ?? '';
    if (user.profile?.id !== uuid) throw forbidden('Invalid profile.');
    if (type !== 'skin' && type !== 'cape') return c.body(null, 400);

    const db = createDb(c.env.DB);
    // 按 uuid 反查角色（多角色用户可为任意自己的角色上传；他人的角色拒绝）
    const [byUuid] = await db.select({ name: uuidMap.name })
      .from(uuidMap).where(eq(uuidMap.uuid, uuid)).limit(1);
    const playerName = byUuid?.name;
    if (!playerName) throw forbidden('The player does not exist.');
    const [player] = await db
      .select({ pid: players.id, name: players.name, userId: players.userId })
      .from(players).where(sql`${players.name} = ${playerName} COLLATE NOCASE`).limit(1);
    if (!player) throw forbidden('The player does not exist.');
    if (player.userId !== user.userId) throw forbidden('Invalid profile.');

    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    const model = String(form?.get('model') ?? 'default');
    if (!file || typeof file === 'string') return c.body(null, 400);
    if ((file as Blob).size > maxBytes) return c.body(null, 413);

    // 复用主站上传管线：走内部 service（校验/扣分/去重/写 R2/建行全一致）
    const { uploadTextureViaYgg } = await import('../services/ygg-upload.ts');
    const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
    await uploadTextureViaYgg(c.env, user.userId, player.pid, type, model, bytes);

    await logYgg(c, `upload-${type}`, player.name, user.userId, player.pid);
    return c.body(null, 204);
  });

  r.delete('/api/user/profile/:uuid/:type', async (c) => {
    const user = await requireBearer(c);
    const uuid = c.req.param('uuid') ?? '';
    const type = c.req.param('type') ?? '';
    if (user.profile?.id !== uuid) throw forbidden('Invalid profile.');
    if (type !== 'skin' && type !== 'cape') return c.body(null, 400);
    // 只清除该 uuid 对应玩家（不能波及用户的其他角色）
    const [byUuid] = await createDb(c.env.DB).select({ name: uuidMap.name })
      .from(uuidMap).where(eq(uuidMap.uuid, uuid)).limit(1);
    if (!byUuid) return c.body(null, 204);
    await createDb(c.env.DB)
      .update(players).set(type === 'skin'
        ? { skinTextureId: null, updatedAt: Date.now() }
        : { capeTextureId: null, updatedAt: Date.now() })
      .where(and(eq(players.name, byUuid.name), eq(players.userId, user.userId)));
    // 玩家档案内容变了：失效边缘缓存的 /{name}.json（与 web 侧 clearTextures 一致）
    await (await import('../services/texture-access.ts')).purgePlayerProfiles(c.env, byUuid.name);
    return c.body(null, 204);
  });

  // 公钥下发
  r.get('/minecraftservices/publickeys', async (c) => {
    const pem = await getSetting(c.env, 'ygg_private_key');
    const pub = (await inspectSigningKey(pem)).publicKey?.replace(/-----[^-]+-----|\s+/g, '') || '';
    if (!pub) {
      // 未配置签名私钥：按契约省略 keys（返回空对象而非空串公钥）
      return c.json({});
    }
    return c.json({
      profilePropertyKeys: [{ publicKey: pub }],
      playerCertificateKeys: [{ publicKey: pub }],
    });
  });

  for (const prefix of ['minecraftservices/minecraft/profile/lookup', 'api/minecraft/profile/lookup']) {
    r.post(`/${prefix}/bulk/byname`, c => {
      const request = new Request(c.req.raw);
      return r.fetch(new Request(new URL('/api/profiles/minecraft', request.url), request), c.env, c.executionCtx);
    });
    r.get(`/${prefix}/name/:username`, c => r.fetch(new Request(new URL(`/api/users/profiles/minecraft/${encodeURIComponent(c.req.param('username'))}`, c.req.url), c.req.raw), c.env, c.executionCtx));
  }
  app.route('/api/yggdrasil', r);
}

// ── 辅助 ─────────────────────────────────────────────────────────────────────

async function tokenInput(c: Ctx, userId: number, clientToken: string, profile: GameProfile | null) {
  const ttl1 = await getSettingInt(c.env, 'ygg_token_expire_1');
  const ttl2 = await getSettingInt(c.env, 'ygg_token_expire_2');
  return {
    userId,
    clientToken,
    profile,
    accessTtlSeconds: ttl1,
    refreshTtlSeconds: ttl2,
  };
}

async function issueToken(c: Ctx, userId: number, clientToken: string, profile: GameProfile | null): Promise<string> {
  return issueYggToken(c.env.DB, await tokenInput(c, userId, clientToken, profile));
}

/** Bearer accessToken（游戏内上传用） */
async function requireBearer(c: Ctx, requiredScope?: string): Promise<{ userId: number; profile: GameProfile | null }> {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw forbidden('Invalid token.');
  return await requireToken(c, token, undefined, false, requiredScope);
}

/** 完整 profile（材质信息 + Mojang 正版回退；回退结果带 __mojang 标记） */
async function fullProfile(
  c: Ctx, uuid: string, name: string,
): Promise<Record<string, unknown> | null> {
  const db = createDb(c.env.DB);
  const [player] = await db
    .select({ pid: players.id, skinTid: players.skinTextureId, capeTid: players.capeTextureId })
    .from(players).where(eq(players.name, name)).limit(1);

  let skinHash: string | null = null;
  let skinModel: string | null = null;
  let capeHash: string | null = null;
  if (player) {
    if (player.skinTid) {
      const [t] = await db.select({ hash: textures.hash, model: textures.model })
        .from(textures).where(eq(textures.id, player.skinTid)).limit(1);
      if (t) { skinHash = t.hash; skinModel = t.model; }
    }
    if (player.capeTid) {
      const [t] = await db.select({ hash: textures.hash })
        .from(textures).where(eq(textures.id, player.capeTid)).limit(1);
      capeHash = t?.hash ?? null;
    }
  }

  // 本站无材质 → Mojang 正版回退（仅当该 uuid 在验证表中，照原插件）
  if (!skinHash && !capeHash) {
    const [v] = await db.select().from(mojangVerifications)
      .where(eq(mojangVerifications.uuid, uuid)).limit(1);
    if (!v) return profilePayload(c, { uuid, name, skinHash, skinModel, capeHash });
    const mojangProfile = await fetchMojangProfile(uuid);
    if (!mojangProfile) return profilePayload(c, { uuid, name, skinHash, skinModel, capeHash });
    return { ...mojangProfile, __mojang: true };
  }

  return await profilePayload(c, { uuid, name, skinHash, skinModel, capeHash });
}

/** Mojang 会话服务器回退（300s 缓存，照原插件） */
async function fetchMojangProfile(uuid: string): Promise<Record<string, unknown> | null> {
  const cache = caches.default;
  const cacheKey = new Request(`https://ygg-cache.internal/mojang/${uuid}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const body = await hit.json();
    return body as Record<string, unknown>;
  }
  const dashed = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
  try {
    const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${dashed}?unsigned=false`);
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    await caches.default.put(cacheKey, new Response(JSON.stringify(body), {
      headers: { 'Cache-Control': 'public, max-age=300' },
    }));
    return body;
  } catch {
    return null;
  }
}
