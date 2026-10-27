
import { type Bindings } from './../core/env.ts';
import { getSettingInt, readSettings } from './../core/settings-reader.ts';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { aiJobs, createDb, notificationTranslations, textures, textureTranslations, texturesDescription } from '@pigeon-skin/db';

import { LOCALES } from '@pigeon-skin/shared/locale';
import { AI_JOB_DEFINITIONS, aiJobProvider, parseJsonOutput, runAiJob, toVerdict, parseVerdict, aiProviderFailureAfter, aiProviderFailureSeq, type AiProviderFailure } from './ai-gateway.ts';
import { readWorkersAiQuota } from './ai-quota.ts';
import { listTaskRuns, writeTaskRun } from './task-runs.ts';
import { backgroundAllowed } from '../core/usage-budget.ts';

const TEXTURE_TRANSLATE_DEF = AI_JOB_DEFINITIONS.texture_translate;
const TEXTURE_MODERATE_DEF = AI_JOB_DEFINITIONS.texture_moderate;
const NOTIFICATION_TRANSLATE_DEF = AI_JOB_DEFINITIONS.notification_translate;

const SUPPORTED_LOCALES = LOCALES;

const MAX_ATTEMPTS = 5;
const MAX_CONCURRENCY_FALLBACK = 2;

export type AiJobKind = 'translate_texture' | 'moderate_texture_name' | 'moderate_texture_description' | 'translate_notification';

// ── 入队 ────────────────────────────────────────────────────────────────────

/**
 * 入队一个 AI 任务：(kind, tid) 已存在则重置为 pending（编辑材质后重跑），
 * 否则插入。返回是否真的写入了行（功能关闭时返回 false 且不写）。
 */
export async function enqueueAiJob(
  env: Pick<Bindings, 'DB'>,
  kind: AiJobKind,
  tid: number,
  options?: { enabled?: boolean },
): Promise<boolean> {
  const enabled = options?.enabled ?? true;
  if (!enabled) return false;
  const now = Date.now();
  await createDb(env.DB)
    .insert(aiJobs)
    .values({ kind, tid, status: 'pending', attempts: 0, nextRunAt: now, lastError: '', createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [aiJobs.kind, aiJobs.tid],
      set: { status: 'pending', attempts: 0, nextRunAt: now, lastError: '', updatedAt: now },
    });
  return true;
}

/**
 * 存量材质补跑：为当前所有材质补齐缺失的 (kind, tid) 任务行，
 * 已有任务（任意状态）不重置，避免把已完成的全部重跑。
 * 只补功能开关处于开启状态的 kind；全关时返回空。
 */
export async function backfillAiJobs(
  env: Bindings,
): Promise<Array<{ kind: AiJobKind; queued: number }>> {
  const values = await readSettings(env);
  const kinds: AiJobKind[] = [];
  if (values.texture_ai_translation === 'true') kinds.push('translate_texture');
  if (values.texture_ai_moderation === 'true') kinds.push('moderate_texture_name', 'moderate_texture_description');
  if (kinds.length === 0) return [];

  const db = createDb(env.DB);
  const results: Array<{ kind: AiJobKind; queued: number }> = [];
  const now = Date.now();
  for (const kind of kinds) {
    const [before] = await db.select({ n: sql<number>`count(*)` }).from(aiJobs).where(eq(aiJobs.kind, kind));
    // INSERT OR IGNORE … SELECT：并发补跑或与上传入队竞争时安全去重；
    // 重写层把 OR IGNORE 机械转换为 PG ON CONFLICT DO NOTHING / MySQL INSERT IGNORE
    await db.run(sql`
      INSERT OR IGNORE INTO ai_jobs (kind, tid, status, attempts, next_run_at, last_error, created_at, updated_at)
      SELECT ${kind}, t.id, 'pending', 0, ${now}, '', ${now}, ${now}
      FROM textures t
      WHERE NOT EXISTS (SELECT 1 FROM ai_jobs j WHERE j.kind = ${kind} AND j.tid = t.id)
    `);
    const [after] = await db.select({ n: sql<number>`count(*)` }).from(aiJobs).where(eq(aiJobs.kind, kind));
    results.push({ kind, queued: (after?.n ?? 0) - (before?.n ?? 0) });
  }
  return results;
}

// ── 派发与执行 ──────────────────────────────────────────────────────────────

/** processing 僵尸阈值：执行超过 10 分钟视为调用方已死（waitUntil 被取消/进程崩溃）。 */
const PROCESSING_STALE_MS = 10 * 60 * 1000;

/** 认领一批到期任务（条件 UPDATE 防跨 isolate 抢占），返回被认领的行。 */
async function claimDueJobs(env: Bindings, limit: number, kinds: AiJobKind[]) {
  const db = createDb(env.DB);
  const now = Date.now();
  // 先回收僵尸 processing：超时未完成的任务放回 pending 队尾
  await db
    .update(aiJobs)
    .set({ status: 'pending', nextRunAt: now, updatedAt: now })
    .where(and(inArray(aiJobs.kind, kinds), eq(aiJobs.status, 'processing'), lte(aiJobs.updatedAt, now - PROCESSING_STALE_MS)));
  const candidates = await db
    .select({ id: aiJobs.id })
    .from(aiJobs)
    .where(and(inArray(aiJobs.kind, kinds), eq(aiJobs.status, 'pending'), lte(aiJobs.nextRunAt, now)))
    .orderBy(aiJobs.nextRunAt)
    .limit(limit);
  if (candidates.length === 0) return [];
  const ids = candidates.map((r) => r.id);
  return await db
    .update(aiJobs)
    .set({ status: 'processing', updatedAt: now })
    .where(and(inArray(aiJobs.id, ids), eq(aiJobs.status, 'pending')))
    .returning();
}

/** 单任务失败后的退避：attempts 已含本次，2^n 分钟。 */
function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts, 60) * 60;
}

/**
 * 执行一批到期任务。由 cron（Workers）/ setInterval（Node）/ 入队路径
 * （waitUntil）调用；重复触发是安全的 —— 认领用条件 UPDATE，同一任务
 * 只会被一个调用者拿到。
 */
export async function processDueJobs(env: Bindings): Promise<void> {
  if (!await backgroundAllowed(env)) return;
  const settings = await readSettings(env);
  let kinds: AiJobKind[] = [];
  if (settings.texture_ai_translation === 'true') kinds.push('translate_texture');
  if (settings.texture_ai_moderation === 'true') kinds.push('moderate_texture_name', 'moderate_texture_description');
  if (settings.notification_ai_translation === 'true') kinds.push('translate_notification');
  if (kinds.length === 0) return;
  const quota = await readWorkersAiQuota(env);
  const enabled = await Promise.all(kinds.map(async kind => ({ kind, provider: await aiJobProvider(env, kind === 'translate_texture' ? TEXTURE_TRANSLATE_DEF : kind === 'translate_notification' ? NOTIFICATION_TRANSLATE_DEF : TEXTURE_MODERATE_DEF) })));
  kinds = enabled.filter(item => item.provider !== null && (!quota.paused || item.provider !== 'workers')).map(item => item.kind);
  if (kinds.length === 0) return;
  if (env.WORKLOADS) {
    const target = env.WORKLOADS.get(env.WORKLOADS.idFromName(crypto.randomUUID()));
    const response = await target.fetch('https://workload/ai-jobs', { method: 'POST' });
    await response.arrayBuffer();
    if (!response.ok) throw new Error('AI job worker unavailable');
    return;
  }
  const maxConcurrency = Math.max(1, Math.min(10, await getSettingInt(env, 'ai_max_concurrency') || MAX_CONCURRENCY_FALLBACK));
  const claimed = await claimDueJobs(env, maxConcurrency * 2, kinds);
  if (claimed.length === 0) return;

  const outages = (await Promise.all(claimed.map((job) => runClaimedJob(env, job))))
    .filter((outage): outage is AiProviderFailure => outage !== null);
  if (outages.length === 0) return;

  // 渠道故障影响整条队列：把其余到期任务一起推后，不然下一分钟又拿一批去撞
  // 同一个坏渠道。渠道恢复（配额重置 / 换驱动 / 补凭据）后这些任务自然到期。
  // 超时默认只推后任务自己，但同一批里 ≥2 个任务超时就说明是渠道整体变慢，
  // 不是某条任务的输入问题 —— 按渠道级暂停，别让整条队列在慢渠道上排长队。
  const pausing = outages.filter((outage) => outage.pauseQueue);
  if (outages.filter((outage) => outage.kind === 'timeout').length >= 2) pausing.push(outages.find((outage) => outage.kind === 'timeout')!);
  await pauseDueJobs(env, pausing);
}

/** 渠道级故障时的队列暂停记录去重窗口：与日志同口径。 */
const PAUSE_RECORD_INTERVAL_MS = 5 * 60_000;

/**
 * 渠道级故障时的队列暂停：把全部到期任务推后，并在后台「定时任务」页留下一条
 * 可见记录 —— 渠道停摆是管理员要处理的事（升级套餐 / 换驱动 / 补凭据），
 * 只写日志的话这个页面看不出原因。记录按 kind 去重：停摆期间每次上传都会触发
 * 一次派发，不去重会把这 50 行的小窗口刷满、挤掉定时任务的正常记录。
 */
async function pauseDueJobs(env: Bindings, pausing: AiProviderFailure[]): Promise<void> {
  if (pausing.length === 0) return;
  const now = Date.now();
  const waitMs = Math.max(...pausing.map((outage) => outage.retryAfterMs));
  const worst = pausing.find((outage) => outage.retryAfterMs === waitMs)!;
  const temporary = pausing.filter(outage => !outage.dailyQuota);
  if (temporary.length > 0) await createDb(env.DB)
    .update(aiJobs)
    .set({ nextRunAt: now + Math.max(...temporary.map(outage => outage.retryAfterMs)), updatedAt: now })
    .where(and(eq(aiJobs.status, 'pending'), lte(aiJobs.nextRunAt, now)));
  const detail = `AI 渠道不可用（${worst.kind}）：${worst.message}（队列推后 ${Math.round(waitMs / 60_000)} 分钟）`;
  const last = (await listTaskRuns(env)).find(row => row.name === 'ai_jobs');
  if (last && now - last.ranAt < PAUSE_RECORD_INTERVAL_MS && last.detail.includes(`（${worst.kind}）`)) return;
  await writeTaskRun(env, 'ai_jobs', false, detail, now);
}

/** 单个任务的失败处理结果：返回渠道级故障表示这一批要暂停队列。 */
async function runClaimedJob(
  env: Bindings,
  job: typeof aiJobs.$inferSelect,
): Promise<AiProviderFailure | null> {
  const db = createDb(env.DB);
  const attempts = job.attempts + 1;
  try {
    let error = '';
    switch (job.kind as AiJobKind) {
      case 'translate_texture':
        error = await runTranslateTexture(env, job.tid);
        break;
      case 'moderate_texture_name':
        error = await runModerateTextureName(env, job.tid);
        break;
      case 'moderate_texture_description':
        error = await runModerateTextureDescription(env, job.tid);
        break;
      case 'translate_notification':
        error = await runTranslateNotification(env, job.tid);
        break;
    }
    if (error) throw new AiJobError(error);
    await db.update(aiJobs)
      .set({ status: 'done', attempts, lastError: '', updatedAt: Date.now() })
      .where(eq(aiJobs.id, job.id));
  } catch (e) {
    const message = e instanceof AiJobError ? e.message : String(e).slice(0, 500);
    const outage = e instanceof AiJobError ? e.outage : null;
    // 超时也可能只是这一个任务的问题（超大输入、慢模型）：连续第二次仍按任务失败
    // 计次，免得一条总是超时的任务无限占着队列。配额/限流/鉴权/网络是渠道级的，
    // 不设这个上限 —— 额度次日重置、换驱动或补凭据后它们要能自动继续。
    const repeatedTimeout = outage !== null && outage.kind === 'timeout' && job.lastError.startsWith(OUTAGE_PREFIX);
    if (outage && !repeatedTimeout) {
      // 渠道坏了不是这个任务的问题：保持 pending、不计次数、按渠道间隔重排。
      // 计次数会让一批任务在配额耗尽后接连撞满 MAX_ATTEMPTS 被永久判失败，
      // 配额次日重置也不会自动恢复，管理员只能逐条手动重跑。
      await db.update(aiJobs)
        .set({ status: 'pending', lastError: message, nextRunAt: outage.dailyQuota ? Date.now() : Date.now() + outage.retryAfterMs, updatedAt: Date.now() })
        .where(eq(aiJobs.id, job.id));
      return outage;
    }
    // 材质被删等永久性失败直接 failed，不重试
    const permanent = e instanceof AiJobError && e.permanent;
    const failed = permanent || attempts >= MAX_ATTEMPTS;
    await db.update(aiJobs)
      .set({
        status: failed ? 'failed' : 'pending',
        attempts,
        lastError: message,
        nextRunAt: Date.now() + backoffSeconds(attempts) * 1000,
        updatedAt: Date.now(),
      })
      .where(eq(aiJobs.id, job.id));
    // 计次了也把它交回调用方：同批多个超时会被判成渠道整体变慢，需要暂停队列
    return outage;
  }
  return null;
}

class AiJobError extends Error {
  readonly permanent: boolean;
  /** 渠道级故障（配额/限流/鉴权/超时/网络）：不计失败次数，按渠道间隔重排（pauseQueue 时并暂停整队列）。 */
  readonly outage: AiProviderFailure | null;
  constructor(message: string, options?: { permanent?: boolean; outage?: AiProviderFailure | null }) {
    super(message);
    this.permanent = options?.permanent ?? false;
    this.outage = options?.outage ?? null;
  }
}

/** 渠道故障的 lastError 前缀：既是给管理员看的文案，也是「上一次也是渠道故障」的判据。 */
const OUTAGE_PREFIX = 'AI 渠道不可用（';

/**
 * runAiJob 返回 null 时区分「渠道不可用」与「这次输出不能用」：前者带上渠道故障，
 * 由执行器暂停队列；后者维持原有的失败计数。seq 必须在这次调用前取。
 */
function aiCallFailure(seq: number): AiJobError {
  const outage = aiProviderFailureAfter(seq);
  return outage
    ? new AiJobError(`${OUTAGE_PREFIX}${outage.kind}）：${outage.message}`, { outage })
    : new AiJobError('AI call unavailable or failed');
}

// ── 任务实现 ────────────────────────────────────────────────────────────────

async function loadTextureContent(env: Bindings, tid: number): Promise<{ name: string; description: string } | null> {
  const db = createDb(env.DB);
  const [texture] = await db
    .select({ name: textures.name })
    .from(textures)
    .where(eq(textures.id, tid))
    .limit(1);
  if (!texture) return null;
  const [desc] = await db
    .select({ description: texturesDescription.description })
    .from(texturesDescription)
    .where(eq(texturesDescription.tid, tid))
    .limit(1);
  return { name: texture.name, description: desc?.description ?? '' };
}

interface TranslationPayload {
  translations?: Record<string, { name?: string; description?: string }>;
}

/** 翻译任务：一次调用产出全部支持语言；成功后先删旧译文再写。返回空串=成功。 */
async function runTranslateTexture(env: Bindings, tid: number): Promise<string> {
  const values = await readSettings(env);
  if (values.texture_ai_translation !== 'true') return '';

  const content = await loadTextureContent(env, tid);
  if (!content) throw new AiJobError('texture deleted', { permanent: true });
  if (!content.name && !content.description) return '';

  const request = [
    `Source name: ${content.name || '(empty)'}`,
    `Source description: ${content.description || '(empty)'}`,
    `Target locales: ${SUPPORTED_LOCALES.join(', ')}`,
  ].join('\n');

  const failureSeq = aiProviderFailureSeq();
  const text = await runAiJob(env, TEXTURE_TRANSLATE_DEF, request, { maxChars: 22_000 });
  if (text === null) throw aiCallFailure(failureSeq);
  const parsed = parseJsonOutput<TranslationPayload>(text);
  const translations = parsed?.translations;
  if (!translations || typeof translations !== 'object') {
    throw new AiJobError('unparseable translation output');
  }

  const now = Date.now();
  const rows: Array<typeof textureTranslations.$inferInsert> = [];
  for (const [locale, t] of Object.entries(translations)) {
    if (!SUPPORTED_LOCALES.includes(locale as never)) continue;
    if (!t || typeof t !== 'object') continue;
    const name = typeof t.name === 'string' ? t.name.trim().slice(0, 50) : '';
    const description = typeof t.description === 'string' ? t.description.trim().slice(0, 20_000) : '';
    if (!name && !description) continue;
    rows.push({ tid, locale, name, description, createdAt: now, updatedAt: now });
  }
  if (rows.length === 0) throw new AiJobError('no usable translations in output');

  const db = createDb(env.DB);
  await db.delete(textureTranslations).where(eq(textureTranslations.tid, tid));
  await db.insert(textureTranslations).values(rows);
  return '';
}

interface NotificationTranslationPayload {
  translations?: Record<string, { title?: string; body?: string }>;
}

/**
 * 站点公告翻译。tid 是「模板骨架」（变量未渲染的管理员原文）的 FNV-1a 哈希，
 * 即 ai_jobs 的去重键：同一模板群发给 N 个用户只执行一次。骨架源行由广播方
 * 入队时写入 notification_translations（locale='' 哨兵），本任务据此调用
 * AI —— 个性化变量（邮箱/积分等）从不进入提示词。译文按 (locale, 哈希) 写回
 * （骨架仍含 {{变量}}），读取方按哈希匹配后自行按收件人渲染。源行丢失视为
 * 永久失败。
 */
async function runTranslateNotification(env: Bindings, tid: number): Promise<string> {
  const values = await readSettings(env);
  if (values.notification_ai_translation !== 'true') return '';

  const db = createDb(env.DB);
  const [source] = await db
    .select()
    .from(notificationTranslations)
    .where(and(eq(notificationTranslations.contentHash, String(tid)), eq(notificationTranslations.locale, '')))
    .limit(1);
  if (!source) throw new AiJobError('notification source row missing', { permanent: true });

  const sourceLocale = 'zh_CN';
  const targets = SUPPORTED_LOCALES.filter((l: string) => l !== sourceLocale);
  const request = [
    `Source title: ${source.sourceTitle}`,
    `Source body: ${source.sourceBody}`,
    `Target locales: ${targets.join(', ')}`,
  ].join('\n');

  const failureSeq = aiProviderFailureSeq();
  const text = await runAiJob(env, NOTIFICATION_TRANSLATE_DEF, request, { maxChars: 22_000 });
  if (text === null) throw aiCallFailure(failureSeq);
  const parsed = parseJsonOutput<NotificationTranslationPayload>(text);
  const translations = parsed?.translations;
  if (!translations || typeof translations !== 'object') throw new AiJobError('unparseable translation output');

  const now = Date.now();
  const rows: Array<typeof notificationTranslations.$inferInsert> = [];
  for (const [locale, t] of Object.entries(translations)) {
    if (!targets.includes(locale as never)) continue;
    if (!t || typeof t !== 'object') continue;
    const title = typeof t.title === 'string' ? t.title.trim().slice(0, 500) : '';
    const body = typeof t.body === 'string' ? t.body.trim().slice(0, 20_000) : '';
    if (!title && !body) continue;
    rows.push({ locale, contentHash: String(tid), sourceTitle: source.sourceTitle, sourceBody: source.sourceBody, title, body, createdAt: now, updatedAt: now });
  }
  if (rows.length === 0) throw new AiJobError('no usable translations in output');

  await db
    .insert(notificationTranslations)
    .values(rows)
    .onConflictDoUpdate({
      target: [notificationTranslations.contentHash, notificationTranslations.locale],
      set: { title: sql`excluded.title`, body: sql`excluded.body`, updatedAt: now },
    });
  return '';
}

/** 审核结果写入 textures 的 flagged 列。safe→清标记；unsafe→置标记；无结果→不动。 */
async function applyFlag(
  env: Bindings,
  tid: number,
  field: 'name' | 'description',
): Promise<string> {
  const content = await loadTextureContent(env, tid);
  if (!content) throw new AiJobError('texture deleted', { permanent: true });
  const text = field === 'name' ? content.name : content.description;
  if (!text.trim()) return '';

  const values = await readSettings(env);
  if (values.texture_ai_moderation !== 'true') return '';

  const failureSeq = aiProviderFailureSeq();
  const raw = await runAiJob(env, TEXTURE_MODERATE_DEF, `Field: texture ${field}\nContent:\n${text}`, {
    maxChars: field === 'name' ? 200 : 22_000,
  });
  if (raw === null) throw aiCallFailure(failureSeq);
  const verdict = toVerdict(parseVerdict(raw));
  if (verdict.action === 'allow') {
    await clearFlag(env, tid, field);
    return '';
  }
  const reason = verdict.reason ?? 'flagged';
  const db = createDb(env.DB);
  if (field === 'name') {
    await db.update(textures).set({ nameFlagged: 1, nameFlagReason: reason }).where(eq(textures.id, tid));
  } else {
    await db.update(textures).set({ descriptionFlagged: 1, descriptionFlagReason: reason }).where(eq(textures.id, tid));
  }
  return '';
}

export async function clearFlag(env: Bindings, tid: number, field: 'name' | 'description'): Promise<void> {
  const db = createDb(env.DB);
  const patch = field === 'name'
    ? { nameFlagged: 0, nameFlagReason: '' }
    : { descriptionFlagged: 0, descriptionFlagReason: '' };
  await db.update(textures).set(patch).where(eq(textures.id, tid));
}

function runModerateTextureName(env: Bindings, tid: number): Promise<string> {
  return applyFlag(env, tid, 'name');
}

function runModerateTextureDescription(env: Bindings, tid: number): Promise<string> {
  return applyFlag(env, tid, 'description');
}

// ── 管理员操作 ──────────────────────────────────────────────────────────────

/** 重跑任务：重置为 pending 立即到期。processing 也允许（管理员手动兜底僵尸任务）。 */
export async function retryAiJob(env: Bindings, id: number): Promise<boolean> {
  const now = Date.now();
  const result = await createDb(env.DB)
    .update(aiJobs)
    .set({ status: 'pending', attempts: 0, nextRunAt: now, updatedAt: now })
    .where(and(eq(aiJobs.id, id), inArray(aiJobs.status, ['failed', 'done', 'pending', 'processing'])))
    .returning({ id: aiJobs.id });
  return result.length > 0;
}

/** 取消任务：仅 pending 可取消。 */
export async function cancelAiJob(env: Bindings, id: number): Promise<boolean> {
  const now = Date.now();
  const result = await createDb(env.DB)
    .update(aiJobs)
    .set({ status: 'cancelled', updatedAt: now })
    .where(and(eq(aiJobs.id, id), eq(aiJobs.status, 'pending')))
    .returning({ id: aiJobs.id });
  return result.length > 0;
}

/** 最近的任务列表（管理员后台任务页）。 */
export async function listAiJobs(
  env: Bindings,
  options: { kind?: string; status?: string; page: number; perPage: number },
): Promise<{ items: Array<typeof aiJobs.$inferSelect>; total: number }> {
  const db = createDb(env.DB);
  const conditions = [
    options.kind ? eq(aiJobs.kind, options.kind) : undefined,
    options.status ? eq(aiJobs.status, options.status) : undefined,
  ].filter((c) => c !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [items, [countRow]] = await Promise.all([
    db.select().from(aiJobs).where(where).orderBy(desc(aiJobs.updatedAt)).limit(options.perPage).offset((options.page - 1) * options.perPage),
    db.select({ n: sql<number>`count(*)` }).from(aiJobs).where(where),
  ]);
  return { items, total: countRow?.n ?? 0 };
}
