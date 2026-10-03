// 后台路由与通知路由。
//
// 角色层级规则、会话撤销、群发语句都在 services/admin.ts 与 repositories/admin.ts。
import { Hono } from 'hono';
import { z } from 'zod';
import {
  adminBroadcastInputSchema,
  adminCreateUserInputSchema,
  adminListQuerySchema,
  adminPatchPlayerInputSchema,
  adminPatchUserInputSchema,
  adminSettingsInputSchema,
  texturePatchInputSchema,
} from '@pigeon-skin/shared/schemas';
import {
  currentAdmin, currentUser, fail, paginate, readJson, readJsonOptional, readPagination, readQuery,
} from '../framework.ts';
import { canModifyUser, isValidPlayerName, type PlayerNameRule, type Role } from '@pigeon-skin/shared';
import * as admin from '../services/admin.ts';
import { audit } from '../services/audit.ts';
import * as settingsSvc from '../services/settings.ts';
import { configurationValues, SECRET_PLACEHOLDER } from '../services/configuration.ts';
import * as notifications from '../services/notifications.ts';
import { closetAddInputSchema } from '@pigeon-skin/shared/schemas';
import { getSetting, getSettingInt, getSettingBool } from '../lib.ts';
import * as social from '../services/social.ts';
import type { AppEnv } from '../lib.ts';
import * as tickets from '../services/tickets.ts';
import { enqueueBroadcastEmail, isEmailConfigured, renderEmail, sendEmail } from '../services/email.ts';
import { multipartLimit } from './tickets.ts';

export const adminRoutes = new Hono<AppEnv>();
export const notificationRoutes = new Hono<AppEnv>();

// 后台的每个入口都要管理员，用中间件统一拦住
adminRoutes.use('*', async (c, next) => {
  currentAdmin(c);
  await next();
});

// ── 总览 ─────────────────────────────────────────────────────────────────────

adminRoutes.get('/stats', async (c) => c.json(await admin.stats(c.env)));

// ── 工单 ─────────────────────────────────────────────────────────────────────
adminRoutes.get('/ticket-categories', async c => c.json(await tickets.listCategories(c.env, true)));
adminRoutes.post('/ticket-categories', async c => {
  const actor = currentAdmin(c); const body = await readJson(c, z.object({ name: z.string().trim().min(1).max(80) }));
  const result = await tickets.createCategory(c.env, body.name);
  await audit(c.env, { actorId: actor.id, action: 'admin.settings.update', targetType: 'ticket_category', targetId: result.id, detail: `create:${result.name}` });
  return c.json(result, 201);
});
adminRoutes.patch('/ticket-categories/:id', async c => {
  const actor = currentAdmin(c); const body = await readJson(c, z.object({ name: z.string().trim().min(1).max(80).optional(), hidden: z.boolean().optional(), sortOrder: z.number().int().min(0).max(100000).optional() }));
  const id = Number(c.req.param('id')); if (!Number.isSafeInteger(id) || id < 1) throw fail.invalid();
  const result = await tickets.updateCategory(c.env, id, body);
  await audit(c.env, { actorId: actor.id, action: 'admin.settings.update', targetType: 'ticket_category', targetId: id, detail: 'update' });
  return c.json(result);
});
adminRoutes.delete('/ticket-categories/:id', async c => {
  const actor = currentAdmin(c); const id = Number(c.req.param('id')); if (!Number.isSafeInteger(id) || id < 1) throw fail.invalid();
  const result = await tickets.hideCategory(c.env, id);
  await audit(c.env, { actorId: actor.id, action: 'admin.settings.update', targetType: 'ticket_category', targetId: id, detail: 'hide' });
  return c.json(result);
});
adminRoutes.get('/tickets', async c => {
  const rawPage = Number(c.req.query('page') || 1); if (!Number.isSafeInteger(rawPage) || rawPage < 1) throw fail.invalid();
  const page = rawPage;
  const status = c.req.query('status'); const categoryId = c.req.query('category_id'); const user = c.req.query('user');
  const parsedCategoryId = categoryId === undefined ? undefined : Number(categoryId); if (parsedCategoryId !== undefined && (!Number.isSafeInteger(parsedCategoryId) || parsedCategoryId < 1)) throw fail.invalid();
  const result = await tickets.listAdmin(c.env, { page, perPage: 20, ...(status ? { status } : {}), ...(parsedCategoryId ? { categoryId: parsedCategoryId } : {}), ...(user ? { user } : {}) });
  return c.json({ ...result, page, perPage: 20, totalPages: Math.ceil(result.total / 20) });
});
adminRoutes.get('/tickets/:id', async c => c.json(await tickets.get(c.env, currentAdmin(c), Number(c.req.param('id')))));
adminRoutes.post('/tickets/:id/messages', multipartLimit, async c => {
  const actor = currentAdmin(c); const data = await c.req.raw.formData(); const files: tickets.TicketFile[] = [];
  for (const value of data.getAll('files')) { if (typeof value === 'string') continue; const file = value as File; files.push({ name: file.name || 'attachment', type: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) }); }
  const body = String(data.get('body') || '').trim(); const internal = String(data.get('internal') || '') === 'true';
  const result = await tickets.addMessage(c.env, actor, Number(c.req.param('id')), body, internal, files);
  if (!internal) { const owner = await tickets.owner(c.env, Number(c.req.param('id'))); if (owner && isEmailConfigured(c.env)) c.executionCtx.waitUntil(sendEmail(c.env, { kind: 'ticket-reply', to: owner.email, ticketId: owner.id, ticketNumber: owner.ticketNumber, title: owner.title, summary: body.slice(0, 240), status: owner.status, locale: owner.locale })); }
  return c.json({ ok: true, messageId: result.messageId });
});
adminRoutes.patch('/tickets/:id/status', async c => {
  const actor = currentAdmin(c); const body = await readJson(c, z.object({ status: z.string() }));
  const result = await tickets.setStatus(c.env, actor, Number(c.req.param('id')), body.status);
  if (result.changed) { const owner = await tickets.owner(c.env, Number(c.req.param('id'))); if (owner && isEmailConfigured(c.env)) c.executionCtx.waitUntil(sendEmail(c.env, { kind: 'ticket-status', to: owner.email, ticketId: owner.id, ticketNumber: owner.ticketNumber, title: owner.title, status: body.status, locale: owner.locale })); }
  return c.json({ ok: true, changed: result.changed });
});
adminRoutes.get('/tickets/:id/attachments/:attachmentId', async c => tickets.attachment(c.env, currentAdmin(c), Number(c.req.param('id')), Number(c.req.param('attachmentId'))));

// ── 用户 ─────────────────────────────────────────────────────────────────────

adminRoutes.get('/users', async (c) => {
  const query = readQuery(c, adminListQuerySchema);
  const page = readPagination(c, { defaultPerPage: 20 });
  const { items, total } = await admin.listUsers(c.env, { keyword: query.q }, page);
  return c.json(paginate(items, total, page));
});

adminRoutes.patch('/users/:id', async (c) => {
  const actor = currentAdmin(c);
  const body = await readJsonOptional(c, adminPatchUserInputSchema);
  const result = await admin.patchUser(c.env, actor, Number(c.req.param('id')), body);
  return c.json({ ok: true, ...result });
});

adminRoutes.delete('/users/:id', async (c) => {
  const actor = currentAdmin(c);
  await admin.deleteUser(c.env, actor, Number(c.req.param('id')));
  return c.body(null, 204);
});

// 创建用户
adminRoutes.post('/users', async (c) => {
  const actor = currentAdmin(c);
  const body = await readJson(c, adminCreateUserInputSchema);
  const result = await admin.createUser(c.env, actor, {
    email: body.email,
    nickname: body.nickname,
    password: body.password,
    ...(body.role ? { role: body.role } : {}),
  });
  return c.json(result, 201);
});

// 审计日志
adminRoutes.get('/audit-log', async (c) => {
  currentAdmin(c);
  const page = readPagination(c, { defaultPerPage: 30 });
  const action = c.req.query('action');
  const actorIdRaw = c.req.query('actor_id');
  if (actorIdRaw !== undefined && (!/^\d+$/.test(actorIdRaw) || !Number.isSafeInteger(Number(actorIdRaw)) || Number(actorIdRaw) < 1)) {
    throw fail.invalid();
  }
  const result = await admin.listAuditLog(c.env, {
    ...(action ? { action } : {}),
    ...(actorIdRaw ? { actorId: Number(actorIdRaw) } : {}),
  }, page);
  return c.json(paginate(result.items as Record<string, unknown>[], result.total, page));
});

// 会话管理
adminRoutes.get('/users/:id/sessions', async (c) => {
  const actor = currentAdmin(c);
  const targetId = Number(c.req.param('id'));
  // 层级校验与 DELETE 一致（不能查看同级/更高级用户的会话元数据）
  const target = await admin.findUserRole(c.env, targetId);
  if (target && !canModifyUser(actor.role, target.role as Role)) {
    throw fail.forbidden('admin.cannot_modify_peer');
  }
  const items = await admin.listUserSessions(c.env, targetId);
  return c.json({ items });
});

adminRoutes.delete('/users/:id/sessions', async (c) => {
  const actor = currentAdmin(c);
  await admin.revokeUserSessions(c.env, actor, Number(c.req.param('id')));
  return c.body(null, 204);
});

// ── 纹理 ─────────────────────────────────────────────────────────────────────

adminRoutes.get('/textures', async (c) => {
  const query = readQuery(c, adminListQuerySchema);
  const page = readPagination(c, { defaultPerPage: 20 });
  const { items, total } = await admin.listTextures(c.env, { keyword: query.q }, page);
  return c.json(paginate(items, total, page));
});

// 纹理治理：删除 / 改名/改可见性
adminRoutes.delete('/textures/:id', async (c) => {
  const actor = currentAdmin(c);
  await admin.deleteAnyTexture(c.env, actor, Number(c.req.param('id')));
  return c.body(null, 204);
});

adminRoutes.patch('/textures/:id', async (c) => {
  const actor = currentAdmin(c);
  const body = await readJsonOptional(c, texturePatchInputSchema);
  await admin.patchAnyTexture(c.env, actor, Number(c.req.param('id')), {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
  });
  return c.json({ ok: true });
});

// ── 收藏（后台视角：排查与清理）──────────────────────────────────────────────

adminRoutes.get('/users/:id/closet', async (c) => {
  const actor = currentAdmin(c);
  const target = await admin.findUserRole(c.env, Number(c.req.param('id')));
  if (!target) throw fail.notFound('user.not_found');
  if (!canModifyUser(actor.role, target.role as Role)) throw fail.forbidden('admin.cannot_modify_peer');
  const page = readPagination(c, { defaultPerPage: 20 });
  const { items, total } = await admin.listUserCloset(c.env, Number(c.req.param('id')), page);
  return c.json(paginate(items, total, page));
});

adminRoutes.delete('/users/:id/closet/:textureId', async (c) => {
  const actor = currentAdmin(c);
  await admin.deleteUserClosetEntry(c.env, actor, Number(c.req.param('id')), Number(c.req.param('textureId')));
  return c.body(null, 204);
});

adminRoutes.post('/users/:id/closet', async (c) => {
  const actor = currentAdmin(c);
  const userId = Number(c.req.param('id'));
  const target = await admin.findUserRole(c.env, userId);
  if (!target) throw fail.notFound('user.not_found');
  if (userId !== actor.id && !canModifyUser(actor.role, target.role as Role)) throw fail.forbidden('admin.cannot_modify_peer');
  const body = await readJson(c, closetAddInputSchema);
  await social.collectTexture(c.env, { id: userId, role: 'normal' }, body.textureId, body.name, {
    perClosetItem: await getSettingInt(c.env, 'score_per_closet_item'),
    perLikeAward: await getSettingInt(c.env, 'score_award_per_like'),
    reporterReward: await getSettingInt(c.env, 'reporter_reward_score'),
    refundOnDelete: await getSettingBool(c.env, 'refund_on_delete'),
    reporterScoreDelta: await getSettingInt(c.env, 'reporter_score_delta'),
  });
  await audit(c.env, { actorId: actor.id, action: 'admin.closet.add', targetType: 'user', targetId: userId, detail: `texture:${body.textureId}` });
  return c.json({ ok: true });
});

// ── 玩家 ─────────────────────────────────────────────────────────────────────

adminRoutes.get('/players', async (c) => {
  const query = readQuery(c, adminListQuerySchema);
  const page = readPagination(c, { defaultPerPage: 20 });
  const { items, total } = await admin.listPlayers(c.env, { keyword: query.q }, page);
  return c.json(paginate(items, total, page));
});

adminRoutes.patch('/players/:id', async (c) => {
  const actor = currentAdmin(c);
  const body = await readJsonOptional(c, adminPatchPlayerInputSchema);
  if (body.name !== undefined) {
    const rule = await getSetting(c.env, 'player_name_rule') as PlayerNameRule;
    const regexp = await getSetting(c.env, 'player_name_regexp');
    const min = await getSettingInt(c.env, 'player_name_length_min');
    const max = await getSettingInt(c.env, 'player_name_length_max');
    if (!isValidPlayerName(body.name, rule, regexp) || body.name.length < min || body.name.length > max) {
      throw fail.invalid('player.name_invalid');
    }
  }
  await admin.patchPlayer(c.env, actor, Number(c.req.param('id')), body);
  return c.json({ ok: true });
});

adminRoutes.delete('/players/:id', async (c) => {
  const actor = currentAdmin(c);
  await admin.deletePlayer(c.env, actor, Number(c.req.param('id')));
  return c.body(null, 204);
});

// ── 管理员重置用户密码 ───────────────────────────────────────────────────────
// 生成一次性密码，管理员把它转告用户；用户下次登录可自行再改。
// 生成而非让管理员指定：避免管理员知道（并可能复用）用户的密码。
adminRoutes.post('/users/:id/reset-password', async (c) => {
  const actor = currentAdmin(c);
  const targetId = Number(c.req.param('id'));
  const temporaryPassword = await admin.resetUserPassword(
    c.env, { id: actor.id, role: actor.role }, targetId,
  );
  return c.json({ ok: true, temporaryPassword });
});

// ── 群发通知 ─────────────────────────────────────────────────────────────────

adminRoutes.post('/notifications', async (c) => {
  const actor = currentAdmin(c);
  const body = await readJson(c, adminBroadcastInputSchema);
  const title = body.title || '';
  const content = body.content || '';
  if (body.sendEmail && (!isEmailConfigured(c.env) || !c.env.EMAIL_NOTIFICATIONS)) throw fail.invalid('common.invalid_request', { sendEmail: isEmailConfigured(c.env) ? 'queue_unavailable' : 'email_not_configured' });
  const result = await admin.broadcast(c.env, { ...body, title, content });
  let emailQueued = !body.sendEmail;
  if (body.sendEmail && result.sent) try { emailQueued = await enqueueBroadcastEmail(c.env, { broadcastId: crypto.randomUUID(), receiver: body.receiver, title, content, afterId: 0 }); } catch { emailQueued = false; }
  await audit(c.env, {
    actorId: actor.id, action: 'admin.broadcast',
    detail: `receiver:${String(body.receiver)},sent:${result.sent},emailQueued:${emailQueued}`,
  });
  return c.json({ ...result, emailQueued });
});

adminRoutes.post('/notifications/email-preview', async c => {
  const body = await readJson(c, z.object({ title: z.string().trim().min(1).max(20), content: z.string().max(10_000).default(''), locale: z.string().max(16).optional() }));
  c.header('Cache-Control', 'no-store');
  return c.json(renderEmail({ kind: 'admin-broadcast', to: '', title: body.title || '', content: body.content || '', locale: body.locale ?? null }, c.env.APP_URL));
});

// ── 通知（用户自己的）────────────────────────────────────────────────────────

notificationRoutes.get('/', async (c) => {
  const user = currentUser(c);
  return c.json(await notifications.list(c.env, user.id, {
    unreadOnly: c.req.query('unread') === 'true',
  }));
});

notificationRoutes.post('/:id/read', async (c) => {
  const user = currentUser(c);
  await notifications.markRead(c.env, user.id, Number(c.req.param('id')));
  return c.json({ ok: true });
});

notificationRoutes.post('/read-all', async (c) => {
  const user = currentUser(c);
  await notifications.markAllRead(c.env, user.id);
  return c.json({ ok: true });
});

// ── 运行时设置 ───────────────────────────────────────────────────────────────

adminRoutes.get('/settings', async (c) => {
  const locale = c.req.query('locale') ?? '';
  const values = await settingsSvc.readLocalized(c.env, locale);
  Object.assign(values, await configurationValues(c.env));
  const actor = currentAdmin(c);
  const specs = { ...settingsSvc.SETTING_REGISTRY, ...settingsSvc.EXTRA_SETTINGS };
  for (const [key, spec] of Object.entries(specs)) if ('secret' in spec && spec.secret && values[key]) values[key] = SECRET_PLACEHOLDER;
  if (actor.role !== 'super_admin') {
    for (const [key, spec] of Object.entries(specs)) {
      if ('superAdminOnly' in spec && spec.superAdminOnly) delete values[key];
    }
  }
  return c.json({
    locale,
    values,
    specs,
    overrides: await settingsSvc.localizedKeys(c.env, locale),
    registry: {
      typed: Object.keys(settingsSvc.SETTING_REGISTRY),
      extra: Object.keys(settingsSvc.EXTRA_SETTINGS),
    },
  });
});

adminRoutes.patch('/settings', async (c) => {
  const actor = currentAdmin(c);
  const body = await readJson(c, adminSettingsInputSchema);
  const written = await settingsSvc.writeMany(c.env, body.settings, {
    isSuperAdmin: actor.role === 'super_admin',
  });
  await audit(c.env, {
    actorId: actor.id, action: 'admin.settings.update',
    detail: `keys:${body.settings.map((s) => s.key).join(',')}`,
  });
  return c.json({ ok: true, written });
});

/** 删除某语言的覆盖，回落到全局值 */
adminRoutes.delete('/settings/:key', async (c) => {
  const actor = currentAdmin(c);
  await settingsSvc.clearLocalized(c.env, c.req.param('key'), c.req.query('locale') ?? '');
  await audit(c.env, {
    actorId: actor.id, action: 'admin.settings.update',
    detail: `clear:${c.req.param('key')},locale:${c.req.query('locale') ?? ''}`,
  });
  return c.body(null, 204);
});
