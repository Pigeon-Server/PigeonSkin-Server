// Node 部署入口：装配运行时 → 启动 HTTP 服务 → 启动定时任务与队列消费。
//
// 与 Worker 入口（index.ts）共享同一个 Hono 应用（createApp）与任务执行体
// （tasks.ts）；差别只在平台层 —— HTTP 由 @hono/node-server 提供，
// scheduled 由 setInterval 模拟，队列由 node/queue.ts 的轮询 runner 消费。

import { serve } from '@hono/node-server';
import { createNodeRuntime } from './node/runtime.ts';
import { createApp } from './app.ts';

const runtime = await createNodeRuntime();
const app = createApp();

// @hono/node-server 会把 { incoming, outgoing } 作为 Hono fetch 的第二参数
// （即 c.env）传入，覆盖 Workers 语义的平台绑定。这里包一层，固定注入
// runtime.bindings 与 ExecutionContext（waitUntil 在长驻进程里就是
// "Promise 跑完为止，失败记日志"），业务代码的 c.env/c.executionCtx
// 与 Worker 部署一致。
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const executionCtx = {
  props: {},
  waitUntil(promise: Promise<unknown>): void {
    promise.catch(error => console.error('waitUntil task failed', error));
  },
  passThroughOnException(): void { /* Node 无对等概念 */ },
};

const server = serve({
  fetch: (request) => app.fetch(request, runtime.bindings, executionCtx),
  port,
  hostname: host,
}, info => {
  console.log(`pigeon-skin-server (node) listening on http://${info.address}:${info.port}`);
});

runtime.startCron();
runtime.queueRunner.start();

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  runtime.queueRunner.stop();
  // 先等在途请求排空（上限 10 秒），再关运行时
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 10_000);
    server.close(() => { clearTimeout(timer); resolve(); });
  });
  await runtime.stop();
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
