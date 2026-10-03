// 通知业务规则。
//
// 通知是自有表，不是 Laravel 那套 UUID + morph 结构 —— 迁移工具会把旧数据
// 转换过来（旧 data 里的 {title, content} 拆成 title + body 两列）。
import { createDb, notifications } from '@pigeon-skin/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { fail } from '../framework.ts';
import type { Bindings } from '../env.ts';

export interface NotificationEnv {
  DB: Bindings['DB'];
}

function db(env: NotificationEnv) {
  return createDb(env.DB);
}

const MAX_ITEMS = 100;

export async function list(
  env: NotificationEnv,
  userId: number,
  filter: { unreadOnly: boolean },
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
    })
    .from(notifications)
    .where(
      filter.unreadOnly
        ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
        : eq(notifications.userId, userId),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(MAX_ITEMS);

  return { items: rows, unread: rows.filter((r) => r.readAt === null).length };
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
