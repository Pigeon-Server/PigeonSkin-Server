// Worker 入口：fetch（HTTP）+ scheduled（Cron Triggers）+ Durable Object 类。
import { createApp } from './app.ts';
import { runCleanup } from './services/cleanup.ts';
import { bumpSitemap } from './services/sitemap-cache.ts';
import { resolveConfiguration } from './services/configuration.ts';
import { DerivativeGenerator } from './do/derivatives.ts';
import { OfficialResourceUpdater } from './do/official-resources.ts';
import { syncOfficialResources } from './services/official-updates.ts';
import type { Bindings } from './env.ts';
import { dispatchSearchSubmissions, processSearchSubmissions, searchEngines, type SearchQueueMessage } from './services/search-submissions.ts';
import type { MessageBatch } from '@cloudflare/workers-types';
import { processBroadcastEmail } from './services/email.ts';
import type { EmailQueueMessage } from './services/email.ts';

// DO 类必须从入口模块具名导出，wrangler 才能在部署时接线
export { DerivativeGenerator, OfficialResourceUpdater };

export default {
  ...createApp(),

  /** 每小时清理过期会话/令牌/登录尝试。失败只记日志 —— 下一次触发会补上。 */
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    env = await resolveConfiguration(env);
    ctx.waitUntil(dispatchSearchSubmissions(env));
    ctx.waitUntil(syncOfficialResources(env));
    ctx.waitUntil((async () => {
      const result = await runCleanup(env);
      console.log('cleanup', JSON.stringify(result));
      // sitemap 兜底重建：写入路径的 bump 若有遗漏，每日强制版本+1
      await bumpSitemap();
    })());
  },

  async queue(batch: MessageBatch<SearchQueueMessage | EmailQueueMessage>, env: Bindings): Promise<void> {
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
  },
};
