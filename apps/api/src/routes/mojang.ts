// mojang-verification 内置 —— 原 mojang-verification 插件的语义。
//
// 流程：用户发起 /mojang/verify → Microsoft OAuth（XboxLive.signin scope）
//   → 回调里走 Microsoft→XBL→XSTS→Minecraft 四跳链拿到 MC profile (uuid+name)
//   → 写 mojang_verifications + user_identities(provider='mojang')
//   → 接管同名玩家（通知原主人 + 补偿 score_per_player 分）
//   /mojang/update-uuid → 从 Mojang API 同步当前正版名到 uuid 表。
//
// 凭据（wrangler secrets）：MOJAZNG→ MICROSOFT 使用与 oauth-microsoft-live
// 同一组 ClientId/Secret 是常见配置，但验证链要求 scope 含 XboxLive.signin，
// 独立用 MOJANG_CLIENT_ID/MOJANG_CLIENT_SECRET（未配则端点 404）。

import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createDb, mojangVerifications, noCaseEq, notifications, players, userIdentities, uuidMap, users,
} from '@pigeon-skin/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';

/** 把 helper 产出的含 {COL} 列占位与单个 ? 值占位的 SQL 片段嵌入 drizzle 模板。 */
function embedFrag(frag: string, column: SQL, value: unknown) {
  const [lhs = '', rhs = ''] = frag.split('{COL}');
  const q = rhs.indexOf('?');
  return sql`${sql.raw(lhs)}${column}${sql.raw(rhs.slice(0, q))}${value}${sql.raw(rhs.slice(q + 1))}`;
}
import { AppError, currentUser, toErrorResponse } from '../framework.ts';
import { getSettingInt, type AppEnv } from '../lib.ts';

type Ctx = Context<AppEnv>;

function creds(c: Ctx): { id: string; secret: string } | null {
  const independent = !!(c.env.MOJANG_CLIENT_ID || c.env.MOJANG_CLIENT_SECRET);
  const id = (independent ? c.env.MOJANG_CLIENT_ID : c.env.MICROSOFT_CLIENT_ID) || '';
  const secret = (independent ? c.env.MOJANG_CLIENT_SECRET : c.env.MICROSOFT_CLIENT_SECRET) || '';
  return id && secret ? { id, secret } : null;
}

interface McProfile {
  uuid: string;
  name: string;
}

/** Microsoft → Xbox Live → XSTS → Minecraft 登录链（照搬原 MicrosoftProvider.php） */
async function minecraftProfileFromCode(c: Ctx, code: string): Promise<McProfile> {
  const cred = creds(c)!;
  const redirectUri = `${c.env.APP_URL}/mojang/callback`;

  // 1. Microsoft token
  const tokenRes = await fetch('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cred.id,
      client_secret: cred.secret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new AppError('auth.oauth_failed', 502);
  const { access_token: msToken } = await tokenRes.json<{ access_token?: string }>();
  if (!msToken) throw new AppError('auth.oauth_failed', 502);

  // 2. Xbox Live (XBL)
  const xblRes = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
  });
  if (!xblRes.ok) throw new AppError('auth.oauth_failed', 502);
  const xbl = await xblRes.json<{ Token?: string; DisplayClaims?: { xui?: Array<{ uhs?: string }> } }>();
  const xblToken = xbl.Token;
  const uhs = xbl.DisplayClaims?.xui?.[0]?.uhs;
  if (!xblToken || !uhs) throw new AppError('auth.oauth_failed', 502);

  // 3. XSTS
  const xstsRes = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }),
  });
  if (!xstsRes.ok) {
    // XErr 2148916233 等表示无 Minecraft 授权/区域限制
    const body = await xstsRes.text();
    console.error('XSTS 失败', xstsRes.status, body.slice(0, 200));
    throw new AppError('auth.oauth_failed', 502);
  }
  const xsts = await xstsRes.json<{ Token?: string }>();
  if (!xsts.Token) throw new AppError('auth.oauth_failed', 502);

  // 4. Minecraft 登录
  const mcRes = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }),
  });
  if (!mcRes.ok) throw new AppError('auth.oauth_failed', 502);
  const mc = await mcRes.json<{ access_token?: string }>();
  if (!mc.access_token) throw new AppError('auth.oauth_failed', 502);

  // 5. MC profile（未购买/无 profile 时 404 → 按"未拥有"处理）
  const profileRes = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { authorization: `Bearer ${mc.access_token}` },
  });
  if (!profileRes.ok) throw new AppError('auth.mojang_not_owned', 403);
  const profile = await profileRes.json<{ id?: string; name?: string }>();
  if (!profile.id || !profile.name) throw new AppError('auth.mojang_not_owned', 403);
  return { uuid: profile.id.replace(/-/g, ''), name: profile.name };
}

export function registerMojangRoutes(app: Hono<AppEnv>): void {
  const mojang = new Hono<AppEnv>();
  mojang.onError((error, c) => c.req.method === 'GET'
    ? c.redirect(`${c.get('user') ? '/profile' : '/login'}?mojang_error=${encodeURIComponent(error instanceof AppError ? error.code : 'auth.oauth_failed')}`)
    : toErrorResponse(error, c));
  // 发起验证
  mojang.get('/verify', async (c) => {
    const user = currentUser(c);
    const cred = creds(c);
    if (!cred) throw new AppError('auth.oauth_unavailable', 404);

    const existing = await createDb(c.env.DB)
      .select().from(mojangVerifications).where(eq(mojangVerifications.userId, user.id)).limit(1);
    if (existing.length > 0 && c.req.query('refresh') !== 'true') throw new AppError('auth.mojang_already_verified', 409);

    const state = crypto.randomUUID();
    c.header('set-cookie', `mojang_state=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`);
    const params = new URLSearchParams({
      client_id: cred.id,
      redirect_uri: `${c.env.APP_URL}/mojang/callback`,
      response_type: 'code',
      scope: 'XboxLive.signin offline_access',
      state,
    });
    return c.redirect(`https://login.live.com/oauth20_authorize.srf?${params}`);
  });

  // 回调：验证链 + 绑定
  mojang.get('/callback', async (c) => {
    const user = currentUser(c);
    if (!creds(c)) throw new AppError('auth.oauth_unavailable', 404);

    const url = new URL(c.req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = c.req.header('cookie')?.match(/mojang_state=([^;]+)/)?.[1];
    if (!code || !state || state !== cookieState) throw new AppError('auth.oauth_failed', 400);

    const profile = await minecraftProfileFromCode(c, code);
    const db = createDb(c.env.DB);
    const now = Date.now();
    const [previous] = await db.select({ uuid: mojangVerifications.uuid }).from(mojangVerifications).where(eq(mojangVerifications.userId, user.id)).limit(1);
    if (previous && previous.uuid !== profile.uuid) throw new AppError('auth.mojang_already_verified', 409);

    // UUID 已被别的用户绑定 → 拒绝
    const [uuidTaken] = await db
      .select({ userId: mojangVerifications.userId })
      .from(mojangVerifications).where(eq(mojangVerifications.uuid, profile.uuid)).limit(1);
    if (uuidTaken && uuidTaken.userId !== user.id) {
      throw new AppError('auth.mojang_uuid_taken', 409);
    }

    // 接管同名玩家：原主人失去玩家并收到通知 + 补偿分（照搬原 AccountService::bindAccount）
    const [player] = await db
      .select({ pid: players.id, userId: players.userId })
      .from(players).where(eq(players.name, profile.name)).limit(1);
    if (player && player.userId !== user.id) {
      const compensation = await getSettingInt(c.env, 'score_per_player');
      // 原子加分（sql 表达式自增，避免读-改-写丢更新）
      await db.batch([
        db.update(players).set({ userId: user.id, updatedAt: now })
          .where(eq(players.id, player.pid)),
        db.update(users).set({
          score: sql`${users.score} + ${compensation}`,
          updatedAt: now,
        }).where(eq(users.id, player.userId)),
        db.insert(notifications).values({
          userId: player.userId,
          type: 'mojang_takeover',
          title: 'mojang_takeover.title',
          body: profile.name,
          createdAt: now,
        }),
      ]);
    }

    await db.insert(mojangVerifications)
      .values({ userId: user.id, uuid: profile.uuid, verified: true, createdAt: now })
      .onConflictDoUpdate({
        target: mojangVerifications.userId,
        set: { uuid: profile.uuid, verified: true },
      });
    // 同步进 user_identities（provider=mojang，openid=MC uuid）与 uuid 表
    await db.insert(userIdentities)
      .values({ provider: 'mojang', providerUserId: profile.uuid, userId: user.id, createdAt: now })
      .onConflictDoNothing();
    const ownedPlayer = await db.select({ id: players.id, name: players.name }).from(players)
      .where(and(eq(players.userId, user.id), embedFrag(noCaseEq('{COL}', '?'), sql`${players.name}`, profile.name))).limit(1).then(rows => rows[0]);
    if (ownedPlayer) await db.insert(uuidMap).values({ playerId: ownedPlayer.id, name: ownedPlayer.name, uuid: profile.uuid }).onConflictDoNothing({ target: uuidMap.playerId });

    // 验证奖励分
    const award = await getSettingInt(c.env, 'mojang_verification_score_award');
    if (award > 0 && !previous) {
      await db.update(users).set({
        score: sql`${users.score} + ${award}`,
        updatedAt: now,
      }).where(eq(users.id, user.id));
    }

    return c.redirect('/user');
  });

  // 从 Mojang 官方 API 同步当前正版名（改名后调用）
  mojang.post('/update-uuid', async (c) => {
    const user = currentUser(c);
    const [v] = await createDb(c.env.DB)
      .select().from(mojangVerifications).where(eq(mojangVerifications.userId, user.id)).limit(1);
    if (!v) throw new AppError('auth.mojang_not_verified', 403);

    // 原 update-uuid 走 api.mojang.com/user/profiles/:uuid/names —— 该端点已
    // 逐步关停。现语义：优先用调用方带来的 MC access token（x-mc-token 头，
    // 需客户端在验证链后保存）调 minecraftservices 的 profile；拿不到则回退
    // uuid 表（验证/接管时写入的名称）并在响应里如实标注 needsReverify。
    const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: { authorization: `Bearer ${c.req.header('x-mc-token') ?? ''}` },
    }).catch(() => null);
    let needsReverify = true;
    let current: string | undefined;
    if (res?.ok) {
      const body = await res.json<{ id?: string; name?: string }>().catch(() => null);
      if (body?.id?.replace(/-/g, '') === v.uuid && body.name) { current = body.name; needsReverify = false; }
    }
    if (!current) {
      const [row] = await createDb(c.env.DB)
        .select({ name: uuidMap.name }).from(uuidMap)
        .where(eq(uuidMap.uuid, v.uuid)).limit(1);
      current = row?.name;
    }
    if (!current) throw new AppError('auth.oauth_failed', 502);

    const db = createDb(c.env.DB);
    const [existing] = await db.select({ name: uuidMap.name })
      .from(uuidMap).where(eq(uuidMap.uuid, v.uuid)).limit(1);
    const synced = existing !== undefined && existing.name === current;
    if (!synced) {
      // 名字有变化才写；无 MC token 可用时 current 就是旧名，写库无意义
      if (existing === undefined || existing.name !== current) {
        const ownedPlayer = await db.select({ id: players.id, name: players.name }).from(players)
          .where(and(eq(players.userId, user.id), embedFrag(noCaseEq('{COL}', '?'), sql`${players.name}`, current))).limit(1).then(rows => rows[0]);
        if (ownedPlayer) await db.insert(uuidMap).values({ playerId: ownedPlayer.id, name: ownedPlayer.name, uuid: v.uuid }).onConflictDoNothing({ target: uuidMap.playerId });
      }
    }
    // 诚实响应：MC token 未持久化时走 uuid 表回退，名字是旧值 ——
    // 明确告诉调用方需要重新验证才能同步最新正版名
    return c.json({ ok: true, name: current, synced: !needsReverify && synced, needsReverify });
  });

  // 我的绑定状态
  app.get('/api/v1/me/mojang', async (c) => {
    const user = currentUser(c);
    const [v] = await createDb(c.env.DB)
      .select({ uuid: mojangVerifications.uuid, createdAt: mojangVerifications.createdAt })
      .from(mojangVerifications).where(eq(mojangVerifications.userId, user.id)).limit(1);
    return c.json({ verified: v ?? null, available: !!creds(c) });
  });

  // 解绑
  app.post('/api/v1/me/mojang/unbind', async (c) => {
    const user = currentUser(c);
    await createDb(c.env.DB).delete(mojangVerifications).where(eq(mojangVerifications.userId, user.id));
    await createDb(c.env.DB).delete(userIdentities)
      .where(and(eq(userIdentities.userId, user.id), eq(userIdentities.provider, 'mojang')));
    return c.json({ ok: true });
  });
  app.route('/mojang', mojang);
}
