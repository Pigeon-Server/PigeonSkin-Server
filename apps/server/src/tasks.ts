// 定时任务与队列消费的共享执行体。
//
// Worker 入口（index.ts）由 Cron Triggers 触发 scheduled、由 Queues 触发
// queue；Node 入口（node/entry.ts）由 setInterval 模拟 cron、由队列适配器
// 的轮询 runner 调用这里。两边的语义必须一致：任务失败只记日志，下一次
// 触发会补上。

import { type Bindings } from './core/env.ts';
import { runCleanup } from './services/cleanup.ts';
import { bumpSitemap } from './services/sitemap-cache.ts';
import { ConfigurationError, resolveConfiguration } from './services/configuration.ts';
import { syncOfficialResources } from './services/official-updates.ts';
import { writeTaskRun } from './services/task-runs.ts';
import { dispatchSearchSubmissions, processSearchSubmissions, searchEngines, type SearchQueueMessage } from './services/search-submissions.ts';
import { processBroadcastEmail, type EmailQueueMessage } from './services/email.ts';

/** 跑一个任务并记录结果。任务自身的异常在这里收敛成 ok=0 的记录，不向外抛。 */
async function recordTaskRun(env: Bindings, name: string, run: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  let ok = true;
  let detail: string;
  try {
    const result = await run();
    detail = typeof result === 'string' ? result : JSON.stringify(result ?? null)?.slice(0, 500) ?? '';
  } catch (e) {
    ok = false;
    detail = String(e).slice(0, 500);
  }
  await writeTaskRun(env, name, ok, detail, started);
}

/** Cron Triggers / 定时器每小时的全部工作 */
export async function runScheduledTasks(event: unknown, env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
  void event;
  let configured: Bindings = env;
  let configurationProblem = '';
  try {
    configured = await resolveConfiguration(env);
  } catch (e) {
    // 站点地址等部署配置非法（例如部署时 APP_URL 填错）时，整点维护不能跟着静默停摆：
    // 记一条可见的失败记录。清理与官方资源同步只依赖 DB/R2/DO，用未解析的 env 照常跑；
    // 搜索提交要拼站点地址，拿错误地址提交只会污染索引，跳过。
    configurationProblem = e instanceof ConfigurationError ? e.reason : String(e);
  }
  if (configurationProblem) {
    ctx.waitUntil(writeTaskRun(env, 'configuration', false, `${configurationProblem}（已跳过搜索提交）`, Date.now()));
  } else {
    ctx.waitUntil(dispatchSearchSubmissions(configured));
  }
  ctx.waitUntil(recordTaskRun(configured, 'official_resources', () => syncOfficialResources(configured)));
  ctx.waitUntil(recordTaskRun(configured, 'cleanup', async () => {
    const result = await runCleanup(configured);
    console.log('cleanup', JSON.stringify(result));
    // sitemap 兜底重建：写入路径的 bump 若有遗漏，每日强制版本+1
    await bumpSitemap();
    return result;
  }));
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
