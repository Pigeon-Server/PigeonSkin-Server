// 通知业务规则。
//
// 通知是自有表，不是 Laravel 那套 UUID + morph 结构 —— 迁移工具会把旧数据
// 转换过来（旧 data 里的 {title, content} 拆成 title + body 两列）。
//
// 站点公告（site_message）支持 AI 翻译：群发时以「模板骨架」（管理员写的
// 原文，变量未渲染）为键入队 translate_notification 任务，译文骨架落
// notification_translations。同一模板群发给 N 个用户只翻译一次；模板改一个
// 字哈希即变，旧译文自动失效、任务重跑。用户读取时按其语言取译文骨架并
// 按收件人渲染变量 —— 翻译永远不接触个性化数据（邮箱/积分不会进入 AI），
// 译文也不会带着过期值。无译文回退原文（已渲染变量的成品）。
// 系统通知（举报结果、正版接管）的标题/正文是 i18n 键，由前端翻译，不走这套。
import { createDb, notifications, notificationTranslations, players } from '@pigeon-skin/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { fail } from '../framework.ts';
import { normalizeLocale } from '@pigeon-skin/shared/locale';
import { renderNotificationTemplate } from './notification-template.ts';
import { getSetting, readSettings } from '../lib.ts';
import type { Bindings } from '../env.ts';

export interface NotificationEnv {
  DB: Bindings['DB'];
}

function db(env: NotificationEnv) {
  return createDb(env.DB);
}

const MAX_ITEMS = 100;
const DEFAULT_LOCALE = 'zh_CN';

/** 翻译缓存按「模板骨架」寻址：管理员写的原文（变量未渲染）。FNV-1a，32 位落入 ai_jobs.tid */
export function contentHash(title: string, body: string): number {
  const input = `${title}\u0000${body}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface NotificationLocaleContext {
  siteName: string;
  siteUrl: string;
  player: string;
  email: string;
  uid: number;
  score: number;
}

/**
 * 组装收件人的模板渲染上下文（站点名/地址 + 用户自身数据）。
 * 读取端（list 的译文渲染）与群发端（broadcast）共用同一套变量来源。
 * site_url 是 EXTRA_SETTINGS 键（不在 SETTING_DEFAULTS），经 readSettings 取。
 */
export async function recipientContext(
  env: NotificationEnv & { APP_URL?: string | undefined },
  user: { id: number; email: string; score: number },
): Promise<NotificationLocaleContext> {
  const database = db(env);
  const [player] = await database
    .select({ name: players.name })
    .from(players)
    .where(eq(players.userId, user.id))
    .orderBy(players.id)
    .limit(1);
  const [siteName, settingsValues] = await Promise.all([getSetting(env, 'site_name'), readSettings(env)]);
  return {
    siteName: siteName || 'Pigeon Skin Server',
    siteUrl: settingsValues.site_url ?? env.APP_URL ?? '',
    player: player?.name ?? '',
    email: user.email,
    uid: user.id,
    score: user.score,
  };
}

/**
 * 列出某用户的通知。site_message 按用户语言展示：
 * 取该语言的译文骨架（按模板哈希匹配）后按收件人渲染变量；
 * 无译文回退原文（写入时已渲染过变量的成品）。
 */
export async function list(
  env: NotificationEnv,
  userId: number,
  filter: { unreadOnly: boolean; locale?: string | undefined; templateContext?: NotificationLocaleContext | undefined },
) {
  const database = db(env);
  const rows = await database
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      templateHash: notifications.templateHash,
    })
    .from(notifications)
    .where(
      filter.unreadOnly
        ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
        : eq(notifications.userId, userId),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(MAX_ITEMS);

  const locale = filter.locale ? normalizeLocale(filter.locale) : '';
  const context = filter.templateContext;
  const wantTranslation = locale !== '' && locale !== DEFAULT_LOCALE && context !== undefined;
  // 译文按 (locale, 模板哈希) 寻址，哈希在群发写入时就落在行上（渲染后的
  // 文本因人而异，无法反推骨架），与具体通知 id 无关
  const templateHashes = wantTranslation
    ? [...new Set(rows.map(r => r.templateHash).filter(hash => hash !== ''))]
    : [];
  const translations = templateHashes.length > 0
    ? await database
      .select()
      .from(notificationTranslations)
      .where(and(inArray(notificationTranslations.contentHash, templateHashes), eq(notificationTranslations.locale, locale)))
    : [];
  const byHash = new Map(translations.map(t => [t.contentHash, t]));
  const items = rows.map((row) => {
    // context 已在 wantTranslation 中判空,translation 命中蕴含 context 非空
    const translation = context && row.templateHash ? byHash.get(row.templateHash) : undefined;
    if (!translation || !context) return row;
    return {
      ...row,
      title: renderNotificationTemplate(translation.title || row.title, context),
      body: renderNotificationTemplate(translation.body || (row.body ?? ''), context),
    };
  });

  return { items, unread: rows.filter(r => r.readAt === null).length };
}

/**
 * 标记单条已读。
 *
 * 条件里带 userId：越权读别人的通知会匹配不到行，从而返回 404 ——
 * 这也顺带避免了"这条通知存在吗"的探测。
 */
export async function markRead(
  env: NotificationEnv,
  userId: number,
  notificationId: number,
): Promise<void> {
  const updated = await db(env)
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning({ id: notifications.id });

  if (updated.length === 0) throw fail.notFound('notification.not_found');
}

export async function markAllRead(env: NotificationEnv, userId: number): Promise<void> {
  await db(env)
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}
