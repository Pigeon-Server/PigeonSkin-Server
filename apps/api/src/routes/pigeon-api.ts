import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, currentAdmin, readJson, readPagination, paginate, toErrorResponse } from '../framework.ts';
import { type AppEnv } from '../lib.ts';
import { noCaseEq } from '@pigeon-skin/db';
import { requirePigeonKey, newPigeonSecret, PIGEON_SCOPES } from '../services/pigeon-api.ts';
import { adminImportTexture } from '../services/admin-import.ts';
import { uuidForPlayer } from '../services/ygg-profiles.ts';
import { audit } from '../services/audit.ts';

export function registerPigeonApi(app: Hono<AppEnv>) {
  const r = new Hono<AppEnv>();
  r.onError((error, c) => error instanceof AppError ? c.json({ error: error.code, status: '-1', msg: error.code === 'pigeon.key_invalid' ? 'API密钥无效或已停用' : error.code === 'pigeon.rate_limited' ? 'API请求达到上限' : 'API密钥权限不足' }, error.status) : toErrorResponse(error, c));
  r.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  const missing = (message: string) => ({ status: '0', msg: message });
  const permission = (role: string) => ({ banned: -1, normal: 0, admin: 1, super_admin: 2 })[role] ?? 0;
  r.get('/player/:action/:name', async c => {
    await requirePigeonKey(c, 'players.read');
    const action = c.req.param('action');
    if (!['status', 'getUUID'].includes(action)) return c.notFound();
    const player = await c.env.DB.prepare(`SELECT p.id, p.user_id, u.nickname, u.role FROM players p JOIN users u ON u.id = p.user_id WHERE ${noCaseEq('p.name', '?')}`).bind(c.req.param('name')).first<{ id: number; user_id: number; nickname: string; role: string }>();
    if (!player) return c.json(missing('玩家不存在'));
    const profile = await uuidForPlayer(c, player.id);
    return action === 'getUUID' ? c.json({ status: '1', UUID: profile.id }) : c.json({ status: '1', useruid: player.user_id, usernickname: player.nickname, playeruuid: profile.id, userstatus: player.role === 'banned' ? '0' : '1', msg: player.role === 'banned' ? '账户封禁中' : '账户正常' });
  });
  r.get('/user/:action/:value', async c => {
    const action = c.req.param('action'), value = c.req.param('value');
    const scope = ['emailGetUid', 'getEmail'].includes(action) ? 'users.email' : 'users.read';
    await requirePigeonKey(c, scope);
    if (action === 'playerGetUid') {
      const row = await c.env.DB.prepare(`SELECT user_id FROM players WHERE ${noCaseEq('name', '?')}`).bind(value).first<{ user_id: number }>();
      return c.json(row ? { status: '1', UID: row.user_id } : missing('玩家不存在'));
    }
    if (action === 'emailGetUid') {
      if (!z.string().email().safeParse(value).success) return c.json({ status: '-1', msg: '邮箱格式无效' });
      const row = await c.env.DB.prepare(`SELECT id FROM users WHERE ${noCaseEq('email', '?')}`).bind(value).first<{ id: number }>();
      return c.json(row ? { status: '1', UID: row.id } : missing('用户不存在'));
    }
    if (!/^[1-9]\d*$/.test(value)) return c.json({ status: '-1', msg: '用户 ID 无效' });
    const user = await c.env.DB.prepare('SELECT id, email, role, created_at, email_verified_at, score FROM users WHERE id = ?').bind(Number(value)).first<{ id: number; email: string; role: string; created_at: number; email_verified_at: number | null; score: number }>();
    if (!user) return c.json(missing('用户不存在'));
    if (action === 'getPlayers') {
      const { results } = await c.env.DB.prepare('SELECT name FROM players WHERE user_id = ? ORDER BY id').bind(user.id).all<{ name: string }>();
      return c.json({ status: '1', PlayerList: results.map(p => p.name) });
    }
    const values: Record<string, unknown> = { emailVerified: { Verified: user.email_verified_at !== null }, getEmail: { Email: user.email }, isAdmin: { isAdmin: ['admin', 'super_admin'].includes(user.role) }, UserPermission: { Permission: permission(user.role) }, getUserRegisterAt: { Register_At: new Date(user.created_at).toISOString() }, getUserScore: { Score: user.score } };
    if (!values[action]) return c.notFound();
    return c.json({ status: '1', ...values[action] as Record<string, unknown> });
  });
  r.get('/system/apiKeyStatus', async c => {
    const key = await requirePigeonKey(c);
    return c.json({ status: '1', msg: 'apikey存在且可用', usageCount: key.usage_count + 1 });
  });
  app.route('/api/ps-api', r);

  app.get('/api/v1/admin/pigeon/keys', async c => {
    currentAdmin(c); const page = readPagination(c);
    const total = await c.env.DB.prepare('SELECT count(*) AS n FROM pigeon_api_keys').first<{ n: number }>();
    const { results } = await c.env.DB.prepare('SELECT id, label, prefix, scopes, enabled, revoked_at AS revokedAt, created_at AS createdAt, last_used_at AS lastUsedAt, usage_count AS usageCount FROM pigeon_api_keys ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(page.perPage, page.offset).all();
    return c.json(paginate(results, total?.n ?? 0, page));
  });
  // 管理级批量纹理导入：API key（admin.texture.import scope）鉴权，
  // 刻意挂在 /admin 之外 —— 全局 admin 会话守卫（app.ts）会先于路由执行，
  // 运维 CLI 没有 Web 会话。路径带 pigeon 前缀保持与 key 管理一致的命名空间。
  app.post('/api/v1/pigeon/admin/import/textures', async c => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.texture.import');
    const kind = c.req.query('kind');
    if (kind !== 'skin' && kind !== 'cape') throw new AppError('common.invalid_request', 422);
    const modelText = c.req.query('model') ?? 'default';
    if (kind === 'cape') {
      if (modelText !== 'default') throw new AppError('common.invalid_request', 422);
    } else if (modelText !== 'default' && modelText !== 'slim') {
      throw new AppError('common.invalid_request', 422);
    }
    const visibilityText = c.req.query('visibility');
    if (visibilityText !== undefined && visibilityText !== 'public' && visibilityText !== 'private') {
      throw new AppError('common.invalid_request', 422);
    }
    const visibility = visibilityText === 'private' ? 'private' : 'public';
    const originText = c.req.query('origin');
    if (originText !== undefined && originText !== 'original' && originText !== 'repost') {
      throw new AppError('common.invalid_request', 422);
    }
    const origin = originText === 'repost' ? 'repost' : 'original';
    const uploaderText = c.req.query('uploader');
    let uploaderId: number | null = null;
    if (uploaderText) {
      const row = /^[1-9]\d*$/.test(uploaderText)
        ? await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(Number(uploaderText)).first<{ id: number }>()
        : await c.env.DB.prepare(`SELECT id FROM users WHERE ${noCaseEq('email', '?')}`).bind(uploaderText).first<{ id: number }>();
      if (!row) throw new AppError('common.invalid_request', 422, 'uploader 不存在');
      uploaderId = row.id;
    }
    // 名称：可选（缺省 import- + 随机 8 位，保证不撞 texture_name_regexp）
    const name = (c.req.query('name') ?? `import-${crypto.randomUUID().slice(0, 8)}`).slice(0, 64);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0) throw new AppError('texture.file_missing', 422);
    let result;
    try {
      result = await adminImportTexture(c.env, {
        bytes, kind, model: kind === 'cape' ? null : modelText as 'default' | 'slim',
        name, visibility, origin, uploaderId,
      });
    } catch (e) {
      // 诊断：管理导入失败时把真实原因带回去（AppError 之外的异常一律 500 会被 app 层吞掉详情）
      if (e instanceof AppError) throw e;
      throw new AppError('common.internal_error', 500, (e as Error).message.slice(0, 300));
    }
    if (!result.existing) {
      await audit(c.env, { actorId: null, action: 'admin.texture.import', targetType: 'texture', targetId: result.id, detail: `apiKey:${key.id} ${hash12(result.hash)}` });
    }
    return c.json({ ...result, skipped: result.existing }, result.existing ? 200 : 201);
  });
  app.post('/api/v1/admin/pigeon/keys', async c => {
    const actor = currentAdmin(c);
    const body = await readJson(c, z.object({ label: z.string().trim().min(1).max(100), scopes: z.array(z.enum(PIGEON_SCOPES)).min(1).max(PIGEON_SCOPES.length) }));
    const minted = await newPigeonSecret(), id = crypto.randomUUID();
    await c.env.DB.prepare('INSERT INTO pigeon_api_keys (id, label, secret_hash, prefix, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, body.label, minted.hash, minted.prefix, JSON.stringify([...new Set(body.scopes)]), actor.id, Date.now()).run();
    await audit(c.env, { actorId: actor.id, action: 'admin.pigeon.key.create', detail: id });
    return c.json({ id, secret: minted.secret }, 201);
  });
  app.patch('/api/v1/admin/pigeon/keys/:id', async c => {
    const actor = currentAdmin(c), body = await readJson(c, z.object({ enabled: z.boolean() }));
    const changed = await c.env.DB.prepare('UPDATE pigeon_api_keys SET enabled = ? WHERE id = ? AND revoked_at IS NULL RETURNING id').bind(Number(body.enabled), c.req.param('id')).first();
    if (!changed) return c.notFound();
    await audit(c.env, { actorId: actor.id, action: 'admin.pigeon.key.update', detail: c.req.param('id') });
    return c.json({ ok: true });
  });
  app.post('/api/v1/admin/pigeon/keys/:id/rotate', async c => {
    const actor = currentAdmin(c), minted = await newPigeonSecret();
    const changed = await c.env.DB.prepare('UPDATE pigeon_api_keys SET secret_hash = ?, prefix = ?, window_start = 0, window_count = 0 WHERE id = ? AND revoked_at IS NULL RETURNING id').bind(minted.hash, minted.prefix, c.req.param('id')).first();
    if (!changed) return c.notFound();
    await audit(c.env, { actorId: actor.id, action: 'admin.pigeon.key.update', detail: c.req.param('id') });
    return c.json({ secret: minted.secret });
  });
  app.delete('/api/v1/admin/pigeon/keys/:id', async c => {
    const actor = currentAdmin(c);
    await c.env.DB.prepare('UPDATE pigeon_api_keys SET enabled = 0, revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(Date.now(), c.req.param('id')).run();
    await audit(c.env, { actorId: actor.id, action: 'admin.pigeon.key.update', detail: c.req.param('id') });
    return c.body(null, 204);
  });
}

function hash12(hash: string): string {
  return hash.slice(0, 12);
}
