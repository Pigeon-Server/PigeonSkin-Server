// Pigeon 管理级 API（machine-facing）—— 用户/纹理治理、统计与审计查询、设置与广播。
//
// 鉴权走 pigeonApiKeys（requirePigeonKey + scope），挂在 /api/v1/pigeon/admin/*
// 而非 /api/v1/admin/*：后者有全局 Web 会话守卫（app.ts），运维 CLI 没有 Web 会话。
// 业务逻辑全部复用 services/admin.ts 与 services/settings.ts，本文件只做
// 鉴权 → 解析 → 调用 → 审计 的粘合，与 routes/admin.ts 的分层一致。
import { Hono } from 'hono';
import {
  adminBroadcastInputSchema, adminCreateUserInputSchema, adminListQuerySchema,
  adminPatchUserInputSchema, adminSettingsInputSchema, texturePatchInputSchema,
} from '@pigeon-skin/shared/schemas';
import { requirePigeonKey } from '../services/pigeon-api.ts';
import * as admin from '../services/admin.ts';
import * as settingsSvc from '../services/settings.ts';
import { enqueueBroadcastEmail, isEmailConfigured } from '../services/email.ts';
import { audit } from '../services/audit.ts';
import { fail, paginate, readJson, readJsonOptional, readPagination, readQuery } from '../framework.ts';
import { compileSearchInput } from '../search/index.ts';
import { SECRET_PLACEHOLDER } from '../services/configuration.ts';
import type { AppEnv } from '../lib.ts';
import { isAdmin, type Role } from '@pigeon-skin/shared';

/**
 * admin.* 服务函数要求 actor（用户层级校验用），且服务层内部会写审计
 * （actor_id 有 users FK）。机器 key 无用户身份，取 key 的签发者
 * （pigeon_api_keys.created_by —— key 属主对 key 的操作负责）作为 actor。
 *
 * 关键安全约束：actor.role 必须是签发者的**当前**角色（每次请求实时查询），
 * 而不是签发时的角色 —— 否则 admin 签发的 key 可对 super_admin 执行
 * canModifyUser 拦截之外的越权操作，签发者被降级后 key 仍保持旧权限。
 * scope 是能力边界（能调哪组端点），签发者角色是数据边界（能碰谁）。
 */
async function keyActor(
  c: { env: { DB: D1Database } },
  key: { id: string; created_by: number | null },
): Promise<{ actor: { id: number; role: Role }; keyId: string }> {
  if (key.created_by === null) throw fail.forbidden();
  const owner = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(key.created_by).first<{ role: Role }>();
  if (!owner || !isAdmin(owner.role)) throw fail.forbidden();
  return { actor: { id: key.created_by, role: owner.role }, keyId: key.id };
}

export function registerPigeonAdminApi(app: Hono<AppEnv>) {

  // ── 用户管理（scope: admin.users.write）───────────────────────────────────

  app.post('/api/v1/pigeon/admin/users', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.users.write');
    const body = await readJson(c, adminCreateUserInputSchema);
    const { actor } = await keyActor(c, key);
    const result = await admin.createUser(c.env, actor, {
      email: body.email,
      nickname: body.nickname,
      password: body.password,
      ...(body.role ? { role: body.role } : {}),
    });
    return c.json(result, 201);
  });

  app.get('/api/v1/pigeon/admin/users', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.users.write');
    await keyActor(c, key);
    const query = readQuery(c, adminListQuerySchema);
    const page = readPagination(c, { defaultPerPage: 20 });
    const result = await admin.listUsers(c.env, { search: compileSearchInput(query.q, 'adminUsers') }, page);
    return c.json(paginate(result.items as Record<string, unknown>[], result.total, page));
  });

  app.patch('/api/v1/pigeon/admin/users/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.users.write');
    const body = await readJsonOptional(c, adminPatchUserInputSchema);
    const { actor } = await keyActor(c, key);
    const targetId = Number(c.req.param('id'));
    const result = await admin.patchUser(c.env, actor, targetId, body);
    return c.json({ ok: true, ...result });
  });

  app.delete('/api/v1/pigeon/admin/users/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.users.write');
    const { actor } = await keyActor(c, key);
    const targetId = Number(c.req.param('id'));
    await admin.deleteUser(c.env, actor, targetId);
    return c.body(null, 204);
  });

  app.post('/api/v1/pigeon/admin/users/:id/reset-password', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.users.write');
    const { actor } = await keyActor(c, key);
    const targetId = Number(c.req.param('id'));
    const temporaryPassword = await admin.resetUserPassword(c.env, actor, targetId);
    return c.json({ ok: true, temporaryPassword });
  });

  app.delete('/api/v1/pigeon/admin/users/:id/sessions', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.users.write');
    const { actor } = await keyActor(c, key);
    const targetId = Number(c.req.param('id'));
    await admin.revokeUserSessions(c.env, actor, targetId);
    return c.body(null, 204);
  });

  // ── 纹理治理（scope: admin.textures.write）────────────────────────────────

  app.get('/api/v1/pigeon/admin/textures', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.textures.write');
    await keyActor(c, key);
    const query = readQuery(c, adminListQuerySchema);
    const page = readPagination(c, { defaultPerPage: 20 });
    const result = await admin.listTextures(c.env, { search: compileSearchInput(query.q, 'adminTextures') }, page);
    return c.json(paginate(result.items as Record<string, unknown>[], result.total, page));
  });

  app.patch('/api/v1/pigeon/admin/textures/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.textures.write');
    const body = await readJson(c, texturePatchInputSchema);
    const { actor } = await keyActor(c, key);
    const targetId = Number(c.req.param('id'));
    await admin.patchAnyTexture(c.env, actor, targetId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
    });
    return c.json({ ok: true });
  });

  app.delete('/api/v1/pigeon/admin/textures/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.textures.write');
    const { actor } = await keyActor(c, key);
    const targetId = Number(c.req.param('id'));
    await admin.deleteAnyTexture(c.env, actor, targetId);
    return c.body(null, 204);
  });

  // ── 统计与审计查询（scope: admin.stats.read，只读不审计）──────────────────

  app.get('/api/v1/pigeon/admin/stats', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.stats.read');
    await keyActor(c, key);
    return c.json(await admin.stats(c.env));
  });

  app.get('/api/v1/pigeon/admin/audit-log', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.stats.read');
    await keyActor(c, key);
    const page = readPagination(c, { defaultPerPage: 30 });
    const action = c.req.query('action');
    const actorIdRaw = c.req.query('actor_id');
    if (actorIdRaw !== undefined && (!/^\d+$/.test(actorIdRaw) || !Number.isSafeInteger(Number(actorIdRaw)) || Number(actorIdRaw) < 1)) {
      throw fail.invalid();
    }
    const result = await admin.listAuditLog(c.env, {
      ...(action ? { action } : {}),
      ...(actorIdRaw ? { actorId: Number(actorIdRaw) } : {}),
      search: compileSearchInput(c.req.query('q'), 'auditLog'),
    }, page);
    return c.json(paginate(result.items as Record<string, unknown>[], result.total, page));
  });

  // ── 设置与广播（scope: admin.settings.write）──────────────────────────────

  app.get('/api/v1/pigeon/admin/settings', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.settings.write');
    await keyActor(c, key);
    const locale = c.req.query('locale') ?? '';
    const values = await settingsSvc.readLocalized(c.env, locale);
    const specs = { ...settingsSvc.SETTING_REGISTRY, ...settingsSvc.EXTRA_SETTINGS };
    // API key 无 super_admin 概念：secret 键一律脱敏、superAdminOnly 键一律不返回
    for (const [key, spec] of Object.entries(specs)) {
      if ('secret' in spec && spec.secret && values[key]) values[key] = SECRET_PLACEHOLDER;
      if ('superAdminOnly' in spec && spec.superAdminOnly) delete values[key];
    }
    return c.json({ locale, values });
  });

  app.patch('/api/v1/pigeon/admin/settings', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.settings.write');
    await keyActor(c, key);
    const body = await readJson(c, adminSettingsInputSchema);
    // isSuperAdmin=false：secret/superAdminOnly 键经 API 不可写（与低权限管理员一致）
    const written = await settingsSvc.writeMany(c.env, body.settings, { isSuperAdmin: false });
    await audit(c.env, {
      actorId: null, action: 'admin.settings.update',
      detail: `apiKey:${key.id} keys:${body.settings.map((s) => s.key).join(',')}`,
    });
    return c.json({ ok: true, written });
  });

  app.post('/api/v1/pigeon/admin/notifications', async (c) => {
    c.header('Cache-Control', 'no-store');
    const key = await requirePigeonKey(c, 'admin.settings.write');
    await keyActor(c, key);
    const body = await readJson(c, adminBroadcastInputSchema);
    const title = body.title || '';
    const content = body.content || '';
    if (body.sendEmail && (!isEmailConfigured(c.env) || !c.env.EMAIL_NOTIFICATIONS)) throw fail.invalid('common.invalid_request', { sendEmail: isEmailConfigured(c.env) ? 'queue_unavailable' : 'email_not_configured' });
    const result = await admin.broadcast(c.env, { ...body, title, content });
    let emailQueued = !body.sendEmail;
    if (body.sendEmail && result.sent) try { emailQueued = await enqueueBroadcastEmail(c.env, { broadcastId: crypto.randomUUID(), receiver: body.receiver, title, content, afterId: 0 }); } catch { emailQueued = false; }
    await audit(c.env, {
      actorId: null, action: 'admin.broadcast',
      detail: `apiKey:${key.id} receiver:${String(body.receiver)},sent:${result.sent},emailQueued:${emailQueued}`,
    });
    return c.json({ ...result, emailQueued });
  });
}
