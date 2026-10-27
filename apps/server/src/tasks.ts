// 定时任务与队列消费的共享执行体。
//
// Worker 入口（index.ts）由 Cron Triggers 触发 scheduled、由 Queues 触发
// queue；Node 入口（node/entry.ts）由 setInterval 模拟 cron、由队列适配器
// 的轮询 runner 调用这里。两边的语义必须一致：任务失败只记日志，下一次
// 触发会补上。

import { type Bindings } from './core/env.ts';
import { backgroundAllowed, noteD1Failure, isD1QuotaError, quotaResetAt, syncD1Usage } from './core/usage-budget.ts';
import { runCleanup } from './services/cleanup.ts';
import { bumpSitemap } from './services/sitemap-cache.ts';
import { ConfigurationError, resolveConfiguration } from './services/configuration.ts';
import { syncOfficialResources } from './services/official-updates.ts';
import { getSettingBool } from './core/settings-reader.ts';
import { startTextureSanitize, textureSanitizeStatus } from './services/texture-sanitize.ts';
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
    await noteD1Failure(env, e);
    if (isD1QuotaError(e)) return;
    ok = false;
    detail = String(e).slice(0, 500);
  }
  await writeTaskRun(env, name, ok, detail, started);
}

/** Cron Triggers / 定时器每小时的全部工作 */
export async function runScheduledTasks(event: unknown, env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
  await syncD1Usage(env);
  if (!await backgroundAllowed(env)) return;
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
  if (configured.OFFICIAL_CATALOG_ENABLED !== 'false' && await getSettingBool(configured, 'official_resources_auto_update')) ctx.waitUntil(recordTaskRun(configured, 'official_resources', () => syncOfficialResources(configured)));
  // 存量材质元数据清理：只处理 sanitized=0 的行，全部清理完就是一次空查（零成本）。
  // DO 侧自带游标与 alarm 链，这里每小时唤醒一次即可自动续跑。
  // 绑定的 DO 不可用（例如本地 Node 未装配该 namespace）时跳过，不影响其它任务。
  ctx.waitUntil(recordTaskRun(configured, 'texture_sanitize', async () => {
    if (!configured.TEXTURE_SANITIZER) return { pending: 0, skipped: true };
    const status = await textureSanitizeStatus(configured);
    if (!status.pending) return { pending: 0 };
    await startTextureSanitize(configured);
    return { pending: status.pending };
  }));
  ctx.waitUntil(recordTaskRun(configured, 'cleanup', async () => {
    const result = await runCleanup(configured);
    console.log('cleanup', JSON.stringify(result));
    // sitemap 兜底重建：写入路径的 bump 若有遗漏，每日强制版本+1
    await bumpSitemap(env);
    return result;
  }));
}

/** 队列消息批次的统一消费逻辑（搜索提交 + 广播邮件） */
export async function processQueueBatch(batch: MessageBatch<SearchQueueMessage | EmailQueueMessage>, env: Bindings): Promise<void> {
  if (!await backgroundAllowed(env)) {
    for (const message of batch.messages) message.retry({ delaySeconds: Math.max(60, Math.min(43200, Math.ceil((quotaResetAt() - Date.now()) / 1000))) });
    return;
  }
  try { env = await resolveConfiguration(env); }
  catch (error) {
    await noteD1Failure(env, error);
    for (const message of batch.messages) message.retry({ delaySeconds: 300 });
    return;
  }
  for (const message of batch.messages) {
    if (!message.body) { message.ack(); continue; }
    if (env.WORKLOADS) {
      try {
        const target = env.WORKLOADS.get(env.WORKLOADS.idFromName(crypto.randomUUID()));
        const response = await target.fetch('https://workload/queue', { method: 'POST', body: JSON.stringify(message.body) });
        const result = await response.json<{ retryAfter?: number }>();
        if (response.ok && !result.retryAfter) message.ack();
        else message.retry({ delaySeconds: result.retryAfter ?? 300 });
      } catch { message.retry({ delaySeconds: 300 }); }
      continue;
    }
    if ('broadcastId' in message.body) {
      try {
        await processBroadcastEmail(env, message.body);
        message.ack();
      } catch (error) { await noteD1Failure(env, error); message.retry({ delaySeconds: 300 }); }
      continue;
    }
    if (!searchEngines.includes(message.body.engine)) { message.ack(); continue; }
    try {
      await processSearchSubmissions(env, message.body.engine);
      message.ack();
    } catch (error) { await noteD1Failure(env, error); message.retry({ delaySeconds: 300 }); }
  }
}
