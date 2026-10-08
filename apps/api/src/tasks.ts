// 定时任务与队列消费的共享执行体。
//
// Worker 入口（index.ts）由 Cron Triggers 触发 scheduled、由 Queues 触发
// queue；Node 入口（node/entry.ts）由 setInterval 模拟 cron、由队列适配器
// 的轮询 runner 调用这里。两边的语义必须一致：任务失败只记日志，下一次
// 触发会补上。

import type { MessageBatch } from '@cloudflare/workers-types';
import { runCleanup } from './services/cleanup.ts';
import { bumpSitemap } from './services/sitemap-cache.ts';
import { resolveConfiguration } from './services/configuration.ts';
import { syncOfficialResources } from './services/official-updates.ts';
import { dispatchSearchSubmissions, processSearchSubmissions, searchEngines, type SearchQueueMessage } from './services/search-submissions.ts';
import { processBroadcastEmail, type EmailQueueMessage } from './services/email.ts';
import type { Bindings } from './env.ts';

/**
 * 记录定时任务运行结果（后台任务页展示）。保留最近 50 条，避免表无限增长。
 */
async function recordTaskRun(env: Bindings, name: string, promise: Promise<unknown>): Promise<void> {
  const started = Date.now();
  let ok = true;
  let detail: string;
  try {
    const result = await promise;
    detail = typeof result === 'string' ? result : JSON.stringify(result ?? null)?.slice(0, 500) ?? '';
  } catch (e) {
    ok = false;
    detail = String(e).slice(0, 500);
  }
  try {
    const db = env.DB;
    await db.prepare('INSERT INTO task_runs (name, ok, detail, ran_at) VALUES (?, ?, ?, ?)')
      .bind(name, ok ? 1 : 0, detail.slice(0, 500), started)
      .run();
    await db.prepare(
      'DELETE FROM task_runs WHERE id NOT IN (SELECT id FROM task_runs ORDER BY ran_at DESC, id DESC LIMIT 50)',
    ).run();
  } catch (e) {
    console.error('task_runs 记录失败', name, e);
  }
}

/** Cron Triggers / 定时器每小时的全部工作 */
export async function runScheduledTasks(event: unknown, env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
  void event;
  env = await resolveConfiguration(env);
  ctx.waitUntil(dispatchSearchSubmissions(env));
  ctx.waitUntil(recordTaskRun(env, 'official_resources', syncOfficialResources(env)));
  ctx.waitUntil((async () => {
    await recordTaskRun(env, 'cleanup', runCleanup(env).then((result) => {
      console.log('cleanup', JSON.stringify(result));
      // sitemap 兜底重建：写入路径的 bump 若有遗漏，每日强制版本+1
      return bumpSitemap().then(() => result);
    }));
  })());
}

/** 队列消息批次的统一消费逻辑（搜索提交 + 广播邮件） */
export async function processQueueBatch(batch: MessageBatch<SearchQueueMessage | EmailQueueMessage>, env: Bindings): Promise<void> {
  try { env = await resolveConfiguration(env); }
  catch {
    for (const message of batch.messages) message.retry({ delaySeconds: 300 });
    return;
  }
  for (const message of batch.messages) {
    if (!message.body) { message.ack(); continue; }
    if ('broadcastId' in message.body) {
      try {
        await processBroadcastEmail(env, message.body);
        message.ack();
      } catch { message.retry({ delaySeconds: 300 }); }
      continue;
    }
    if (!searchEngines.includes(message.body.engine)) { message.ack(); continue; }
    try {
      await processSearchSubmissions(env, message.body.engine);
      message.ack();
    } catch { message.retry({ delaySeconds: 300 }); }
  }
}
