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
  emailSchema,
  texturePatchInputSchema,
} from '@pigeon-skin/shared/schemas';
import {
  AppError, currentAdmin, currentUser, fail, paginate, readJson, readJsonOptional, readPagination, readQuery,
} from '../framework.ts';
import { canModifyUser, isValidPlayerName, type PlayerNameRule, type Role } from '@pigeon-skin/shared';
import * as admin from '../services/admin.ts';
import { compileSearchInput } from '../search/index.ts';
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
import * as aiJobsSvc from '../services/ai-jobs.ts';
import { AI_JOB_DEFINITIONS, defaultModelFor, effectiveDriverKind, fetchAvailableModels, testAiConnection } from '../services/ai-gateway.ts';
import { resetSearchSubmissions, searchEngines } from '../services/search-submissions.ts';
import {
  createDb, searchSubmissions, taskRuns as taskRunsTable, textures as texturesTable,
} from '@pigeon-skin/db';
import { desc, eq, inArray, or, sql } from 'drizzle-orm';

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
  const result = await tickets.listAdmin(c.env, { page, perPage: 20, ...(status ? { status } : {}), ...(parsedCategoryId ? { categoryId: parsedCategoryId } : {}), ...(user ? { user } : {}), search: compileSearchInput(c.req.query('q'), 'tickets') });
  return c.json({ ...result, page, perPage: 20, totalPages: Math.ceil(result.total / 20) });
});
adminRoutes.get('/tickets/:id', async c => c.json(await tickets.get(c.env, currentAdmin(c), Number(c.req.param('id')), true)));
adminRoutes.post('/tickets/:id/messages', multipartLimit, async c => {
  const actor = currentAdmin(c); const data = await c.req.raw.formData(); const files: tickets.TicketFile[] = [];
  for (const value of data.getAll('files')) { if (typeof value === 'string') continue; const file = value as File; files.push({ name: file.name || 'attachment', type: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) }); }
  const body = String(data.get('body') || '').trim(); const internal = String(data.get('internal') || '') === 'true';
  const result = await tickets.addMessage(c.env, actor, Number(c.req.param('id')), body, internal, files, true);
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
  const { items, total } = await admin.listUsers(c.env, { search: compileSearchInput(query.q, 'adminUsers') }, page);
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
    search: compileSearchInput(c.req.query('q'), 'auditLog'),
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
  const { items, total } = await admin.listTextures(c.env, { search: compileSearchInput(query.q, 'adminTextures') }, page);
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
  const { items, total } = await admin.listPlayers(c.env, { search: compileSearchInput(query.q, 'adminPlayers') }, page);
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
  // 翻译任务刚入队：立即触发一次派发（失败也不影响响应，cron 兜底）
  if (result.sent > 0) c.executionCtx.waitUntil(aiJobsSvc.processDueJobs(c.env).catch(() => {}));
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
    // 公告译文按用户语言取：优先账号语言设置，其次 ?lang（与站点界面语言一致）
    locale: user.locale ?? c.req.query('lang'),
    templateContext: await notifications.recipientContext(c.env, user),
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
  // AI 任务的内置默认提示词/模型：前端在覆盖项为空时展示默认值，
  // 让管理员知道"空 = 默认"到底默认的是什么
  const aiDefaults: Record<string, string> = {};
  for (const def of Object.values(AI_JOB_DEFINITIONS)) {
    aiDefaults[`ai_${def.key}_prompt`] = def.defaultPrompt;
    aiDefaults[`ai_${def.key}_model`] = await defaultModelFor(c.env, def);
  }
  // 生效驱动摘要：与 resolveDriverConfig 同一判定（settings 覆盖 > env Key > Workers AI），
  // 前端据此联动显隐凭据字段和获取/测试按钮
  const aiEffectiveDriver = await effectiveDriverKind(c.env);
  return c.json({
    locale,
    values,
    specs,
    aiDefaults,
    aiEffectiveDriver,
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

/** 发测试邮件验证发信配置；凭据与 mail_from 一样仅超管可见，端点同样限超管 */
adminRoutes.post('/settings/email-test', async (c) => {
  const actor = currentAdmin(c);
  if (actor.role !== 'super_admin') throw fail.forbidden('admin.forbidden');
  const body = await readJson(c, z.object({ to: emailSchema.optional() }));
  // 与验证信同一节流桶：免费发信额度有限，不能无限触发出站尝试
  const bucket = `mail-test:${actor.id}`;
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE kind = 'mail' AND identifier = ? AND created_at > ?")
    .bind(bucket, Date.now() - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) > 0) throw new AppError('common.rate_limited', 429);
  const result = await sendEmail(c.env, { kind: 'test-mail', to: body.to || actor.email, locale: actor.locale });
  if (result.ok) await c.env.DB.prepare("INSERT INTO auth_attempts (ip, identifier, kind, succeeded, created_at) VALUES ('', ?, 'mail', 1, ?)").bind(bucket, Date.now()).run();
  await audit(c.env, { actorId: actor.id, action: 'admin.settings.update', detail: `email-test:${result.ok}` });
  // detail 只含失败阶段与 SMTP 响应码（不含响应体），端点已限超管，供界面诊断
  return c.json({ ok: result.ok, reason: result.reason ?? null, detail: result.detail ?? null });
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

// ── 后台任务：AI 任务队列 ───────────────────────────────────────────────────

const AI_JOB_KINDS = ['translate_texture', 'moderate_texture_name', 'moderate_texture_description'] as const;
const AI_JOB_STATUSES = ['pending', 'processing', 'done', 'failed', 'cancelled'] as const;

adminRoutes.get('/ai-jobs', async (c) => {
  currentAdmin(c);
  const kind: string | undefined = AI_JOB_KINDS.includes(c.req.query('kind') as never) ? c.req.query('kind') : undefined;
  const status: string | undefined = AI_JOB_STATUSES.includes(c.req.query('status') as never) ? c.req.query('status') : undefined;
  const page = readPagination(c, { defaultPerPage: 20 });
  const listInput: { kind?: string; status?: string; page: number; perPage: number } = { page: page.page, perPage: page.perPage };
  if (kind) listInput.kind = kind;
  if (status) listInput.status = status;
  const { items, total } = await aiJobsSvc.listAiJobs(c.env, listInput);
  // 关联材质名与上传者，便于直接定位问题内容
  const tids = [...new Set(items.map((j) => j.tid))];
  const textures0 = tids.length > 0
    ? await createDb(c.env.DB).select({
        id: texturesTable.id, name: texturesTable.name, uploaderId: texturesTable.uploaderId,
        nameFlagged: texturesTable.nameFlagged, descriptionFlagged: texturesTable.descriptionFlagged,
      }).from(texturesTable).where(inArray(texturesTable.id, tids))
    : [];
  const byTid = new Map(textures0.map((t) => [t.id, t]));
  return c.json(paginate(items.map((job) => ({
    ...job,
    texture: byTid.get(job.tid) ?? null,
  })), total, page));
});

adminRoutes.post('/ai-jobs/backfill', async (c) => {
  const actor = currentAdmin(c);
  const results = await aiJobsSvc.backfillAiJobs(c.env);
  await audit(c.env, {
    actorId: actor.id, action: 'admin.ai_jobs.backfill',
    detail: results.map((r) => `${r.kind}:${r.queued}`).join(',') || 'none',
  });
  // 存量补齐后立即派发一轮，避免等下一个 cron 周期
  c.executionCtx.waitUntil(aiJobsSvc.processDueJobs(c.env).catch(() => {}));
  return c.json({ results });
});

adminRoutes.post('/ai-jobs/:id/retry', async (c) => {
  const actor = currentAdmin(c);
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) throw fail.notFound();
  const ok = await aiJobsSvc.retryAiJob(c.env, id);
  if (!ok) throw fail.notFound();
  await audit(c.env, { actorId: actor.id, action: 'admin.ai_jobs.retry', detail: String(c.req.param('id')) });
  return c.json({ ok: true });
});

adminRoutes.post('/ai-jobs/:id/cancel', async (c) => {
  const actor = currentAdmin(c);
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) throw fail.notFound();
  const ok = await aiJobsSvc.cancelAiJob(c.env, id);
  if (!ok) throw fail.notFound();
  await audit(c.env, { actorId: actor.id, action: 'admin.ai_jobs.cancel', detail: String(c.req.param('id')) });
  return c.json({ ok: true });
});

// ── 后台任务：AI 审核标记处置 ───────────────────────────────────────────────

adminRoutes.get('/texture-flags', async (c) => {
  currentAdmin(c);
  const page = readPagination(c, { defaultPerPage: 20 });
  const db = createDb(c.env.DB);
  const where = or(
    eq(texturesTable.nameFlagged, 1),
    eq(texturesTable.descriptionFlagged, 1),
  );
  const [items, [countRow]] = await Promise.all([
    db.select({
      id: texturesTable.id,
      name: texturesTable.name,
      nameFlagged: texturesTable.nameFlagged,
      nameFlagReason: texturesTable.nameFlagReason,
      descriptionFlagged: texturesTable.descriptionFlagged,
      descriptionFlagReason: texturesTable.descriptionFlagReason,
      uploaderId: texturesTable.uploaderId,
    }).from(texturesTable)
      .where(where)
      .orderBy(desc(texturesTable.updatedAt))
      .limit(page.perPage).offset(page.offset),
    db.select({ n: sql<number>`count(*)` }).from(texturesTable).where(where),
  ]);
  return c.json(paginate(items, countRow?.n ?? 0, page));
});

adminRoutes.delete('/texture-flags/:id/:field', async (c) => {
  const actor = currentAdmin(c);
  const field = c.req.param('field');
  if (field !== 'name' && field !== 'description') throw fail.invalid();
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) throw fail.notFound();
  await aiJobsSvc.clearFlag(c.env, id, field);
  await audit(c.env, { actorId: actor.id, action: 'admin.texture_flags.clear', detail: `${id}:${field}` });
  return c.json({ ok: true });
});

// ── 后台任务：搜索引擎提交 ──────────────────────────────────────────────────

adminRoutes.get('/search-submissions', async (c) => {
  currentAdmin(c);
  const page = readPagination(c, { defaultPerPage: 20 });
  const db = createDb(c.env.DB);
  const [items, [countRow]] = await Promise.all([
    db.select().from(searchSubmissions).orderBy(desc(searchSubmissions.updatedAt)).limit(page.perPage).offset(page.offset),
    db.select({ n: sql<number>`count(*)` }).from(searchSubmissions),
  ]);
  return c.json(paginate(items, countRow?.n ?? 0, page));
});

adminRoutes.post('/search-submissions/:engine/retry', async (c) => {
  const actor = currentAdmin(c);
  const engine = c.req.param('engine') as typeof searchEngines[number];
  if (!searchEngines.includes(engine)) throw fail.invalid();
  const n = await resetSearchSubmissions(c.env, engine);
  await audit(c.env, { actorId: actor.id, action: 'admin.search_submissions.retry', detail: `${engine}:${n}` });
  return c.json({ ok: true, reset: n });
});

// ── 后台任务：定时任务运行记录 ──────────────────────────────────────────────

adminRoutes.get('/task-runs', async (c) => {
  currentAdmin(c);
  const db = createDb(c.env.DB);
  const rows = await db.select().from(taskRunsTable).orderBy(desc(taskRunsTable.ranAt)).limit(100);
  return c.json({ items: rows });
});

// ── AI 网关：模型列表拉取 ───────────────────────────────────────────────────

adminRoutes.get('/ai-models', async (c) => {
  currentAdmin(c);
  // 表单未保存值通过 query 传入：保存前也能按当前配置拉列表
  const overrides = {
    ai_driver: c.req.query('ai_driver') || undefined,
    ai_api_key: c.req.query('ai_api_key') || undefined,
    openai_base_url: c.req.query('openai_base_url') || undefined,
    ai_systemone_api_key: c.req.query('ai_systemone_api_key') || undefined,
    ai_cloudflare_account_id: c.req.query('ai_cloudflare_account_id') || undefined,
    ai_cloudflare_api_token: c.req.query('ai_cloudflare_api_token') || undefined,
  };
  try {
    const models = await fetchAvailableModels(c.env, overrides);
    return c.json({ models }); // null = 当前驱动无列表 API（Workers AI）
  } catch (e) {
    throw fail.invalid('admin.ai_models_fetch_failed', { reason: String(e).slice(0, 200) });
  }
});

// ── AI 网关：连通性测试 ─────────────────────────────────────────────────────

adminRoutes.post('/ai-test', async (c) => {
  currentAdmin(c);
  // modelField = 按钮所在字段的设置键；edits = 表单未保存值（保存前也能测试）
  const body = await readJsonOptional(c, z.object({
    model: z.string().trim().max(100).optional(),
    modelField: z.string().trim().max(60).optional(),
    edits: z.record(z.string(), z.string().max(10_000)).optional(),
  }));
  const overrides = {
    ai_driver: body.edits?.ai_driver,
    ai_api_key: body.edits?.ai_api_key,
    openai_base_url: body.edits?.openai_base_url,
    ai_timeout_seconds: body.edits?.ai_timeout_seconds,
    ai_systemone_api_key: body.edits?.ai_systemone_api_key,
    ai_cloudflare_account_id: body.edits?.ai_cloudflare_account_id,
    ai_cloudflare_api_token: body.edits?.ai_cloudflare_api_token,
    __modelField: body.modelField,
  };
  const result = await testAiConnection(c.env, body.model, overrides);
  await audit(c.env, { actorId: currentAdmin(c).id, action: 'admin.settings.update', detail: `ai-test:${result.ok}` });
  return c.json(result);
});
