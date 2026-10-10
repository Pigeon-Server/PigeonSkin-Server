// Worker 入口：fetch（HTTP）+ scheduled（Cron Triggers）+ Durable Object 类。
import { createApp } from './app.ts';
import { DerivativeGenerator } from './do/derivatives.ts';
import { OfficialResourceUpdater } from './do/official-resources.ts';
import type { Bindings } from './env.ts';
import type { MessageBatch } from '@cloudflare/workers-types';
import { runScheduledTasks, processQueueBatch } from './tasks.ts';
import { processDueJobs } from './services/ai-jobs.ts';
import type { SearchQueueMessage } from './services/search-submissions.ts';
import type { EmailQueueMessage } from './services/email.ts';

// DO 类必须从入口模块具名导出，wrangler 才能在部署时接线
export { DerivativeGenerator, OfficialResourceUpdater };

export default {
  ...createApp(),

  /**
   * Cron 双计划：`0 * * * *` 跑每小时清理/同步（runScheduledTasks），
   * `* * * * *` 跑 AI 任务派发（processDueJobs，指数退避重试）。
   */
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '* * * * *') {
      ctx.waitUntil(processDueJobs(env));
      return;
    }
    await runScheduledTasks(event, env, ctx);
  },

  async queue(batch: MessageBatch<SearchQueueMessage | EmailQueueMessage>, env: Bindings): Promise<void> {
    await processQueueBatch(batch, env);
  },
};
