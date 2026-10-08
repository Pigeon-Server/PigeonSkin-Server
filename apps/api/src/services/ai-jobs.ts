// AI 后台任务队列：ai_jobs 表做唯一事实源，cron / 入队路径派发。
//
// 为什么不用 Queues / DO alarm（已核对官方计费与 API）：
// - Queues 按操作计费且无去重，队列内容管理员不可列举、失败项不可重驱；
// - DO duration 按墙钟计费，在 DO 里 await LLM 的 25 秒照常计费。
// D1 表天然支持 (kind, tid) 去重、管理员可见可重跑，Node 自托管复用同一执行器。
//
// 执行器 processDueJobs 与触发器分离：Workers 走 Cron Triggers（分钟级），
// Node 走 setInterval；路由层入队后也 waitUntil 立即触发一次（廉价，cron 兜底）。
// 失败任务按 attempts 指数退避（2^n 分钟），超过上限置 failed 等管理员处理。

import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { aiJobs, createDb, textures, textureTranslations, texturesDescription } from '@pigeon-skin/db';
import type { Bindings } from '../env.ts';
import { getSettingInt, readSettings } from '../lib.ts';
import { AI_JOB_DEFINITIONS, parseJsonOutput, runAiJob, toVerdict, parseVerdict } from './ai-gateway.ts';

const TEXTURE_TRANSLATE_DEF = AI_JOB_DEFINITIONS.texture_translate;
const TEXTURE_MODERATE_DEF = AI_JOB_DEFINITIONS.texture_moderate;

const SUPPORTED_LOCALES = ['zh_CN', 'zh_TW', 'en', 'es_ES', 'ru_RU', 'ja_JP'] as const;

const MAX_ATTEMPTS = 5;
const MAX_CONCURRENCY_FALLBACK = 2;

export type AiJobKind = 'translate_texture' | 'moderate_texture_name' | 'moderate_texture_description';

// ── 入队 ────────────────────────────────────────────────────────────────────

/**
 * 入队一个 AI 任务：(kind, tid) 已存在则重置为 pending（编辑材质后重跑），
 * 否则插入。返回是否真的写入了行（功能关闭时返回 false 且不写）。
 */
export async function enqueueAiJob(
  env: Bindings,
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

// ── 派发与执行 ──────────────────────────────────────────────────────────────

/** processing 僵尸阈值：执行超过 10 分钟视为调用方已死（waitUntil 被取消/进程崩溃）。 */
const PROCESSING_STALE_MS = 10 * 60 * 1000;

/** 认领一批到期任务（条件 UPDATE 防跨 isolate 抢占），返回被认领的行。 */
async function claimDueJobs(env: Bindings, limit: number) {
  const db = createDb(env.DB);
  const now = Date.now();
  // 先回收僵尸 processing：超时未完成的任务放回 pending 队尾
  await db
    .update(aiJobs)
    .set({ status: 'pending', nextRunAt: now, updatedAt: now })
    .where(and(eq(aiJobs.status, 'processing'), lte(aiJobs.updatedAt, now - PROCESSING_STALE_MS)));
  const candidates = await db
    .select({ id: aiJobs.id })
    .from(aiJobs)
    .where(and(eq(aiJobs.status, 'pending'), lte(aiJobs.nextRunAt, now)))
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
  const maxConcurrency = Math.max(1, Math.min(10, await getSettingInt(env, 'ai_max_concurrency') || MAX_CONCURRENCY_FALLBACK));
  const claimed = await claimDueJobs(env, maxConcurrency * 2);
  if (claimed.length === 0) return;

  await Promise.all(claimed.map((job) => runClaimedJob(env, job)));
}

async function runClaimedJob(
  env: Bindings,
  job: typeof aiJobs.$inferSelect,
): Promise<void> {
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
    }
    if (error) throw new AiJobError(error);
    await db.update(aiJobs)
      .set({ status: 'done', attempts, lastError: '', updatedAt: Date.now() })
      .where(eq(aiJobs.id, job.id));
  } catch (e) {
    const message = e instanceof AiJobError ? e.message : String(e).slice(0, 500);
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
  }
}

class AiJobError extends Error {
  readonly permanent: boolean;
  constructor(message: string, options?: { permanent?: boolean }) {
    super(message);
    this.permanent = options?.permanent ?? false;
  }
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

  const text = await runAiJob(env, TEXTURE_TRANSLATE_DEF, request, { maxChars: 22_000 });
  if (text === null) throw new AiJobError('AI call unavailable or failed');
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

  const raw = await runAiJob(env, TEXTURE_MODERATE_DEF, `Field: texture ${field}\nContent:\n${text}`, {
    maxChars: field === 'name' ? 200 : 22_000,
  });
  if (raw === null) throw new AiJobError('AI call unavailable or failed');
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
