// 存量材质净化的调度壳。
//
// 规范 §2.7 要求服务端剥离材质里与位图无关的数据。新上传在 uploadTexture
// 里已同步完成，历史行由这个 DO 分批补齐（textures.sanitized = 0 为待办集合）。
//
// 为什么放 DO：4096² 的图单次重编码在本机约 400ms，放在面向用户的请求里
// 会撞 CPU 预算；DO 的 alarm 链既不受单请求 CPU 限制，也不影响用户请求。
// 批处理逻辑本身在 services/texture-sanitize.ts，这里只管游标与重试。

import { type Bindings } from './../core/env.ts';
import { withRequestCache } from '../core/request-cache.ts';
import { newSanitizeJob, sanitizeBatch, type SanitizeJobState } from '../services/texture-sanitize.ts';
import { backgroundAllowed, isD1QuotaError, noteD1Failure, quotaResetAt } from '../core/usage-budget.ts';

export class TextureSanitizer {
  private executing = false;
  private readonly state: DurableObjectState;
  private readonly env: Bindings;
  constructor(state: DurableObjectState, env: Bindings) { this.state = state; this.env = env; }

  fetch(request: Request): Promise<Response> { return withRequestCache(() => this.handleRequest(request)); }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/progress') {
      const job = await this.state.storage.get<SanitizeJobState>('job');
      return Response.json(job ?? null);
    }
    if (request.method !== 'POST' || url.pathname !== '/start') return new Response(null, { status: 404 });
    const reset = url.searchParams.get('reset') === 'true';
    return this.state.blockConcurrencyWhile(async () => {
      let job = reset ? undefined : await this.state.storage.get<SanitizeJobState>('job');
      if (job && !job.done) {
        if (!this.executing && await this.state.storage.getAlarm() == null) await this.state.storage.setAlarm(Date.now() + 1000);
        return Response.json(job, { status: 202 });
      }
      job = newSanitizeJob();
      await this.state.storage.transaction(async storage => {
        await storage.put('job', job);
        await storage.setAlarm(Date.now() + 1000);
      });
      return Response.json(job, { status: 202 });
    });
  }

  /** 处理一批并落盘。返回 true 表示队列已清空。 */
  async runOnce(): Promise<boolean> {
    const job = await this.state.storage.get<SanitizeJobState>('job');
    if (!job || job.done) return true;
    if (!await backgroundAllowed(this.env)) return false;
    this.executing = true;
    try {
      const finished = await sanitizeBatch(this.env, job);
      await this.state.storage.put('job', job);
      return finished;
    } finally {
      this.executing = false;
    }
  }

  alarm(): Promise<void> { return withRequestCache(() => this.handleAlarm()); }

  private async handleAlarm(): Promise<void> {
    if (this.executing) return;
    const job = await this.state.storage.get<SanitizeJobState>('job');
    if (!job || job.done) return;
    if (!await backgroundAllowed(this.env)) { await this.state.storage.setAlarm(quotaResetAt()); return; }
    const original = structuredClone(job);
    this.executing = true;
    try {
      const finished = await sanitizeBatch(this.env, job);
      await this.state.storage.transaction(async storage => {
        await storage.put('job', job);
        if (!finished) await storage.setAlarm(Date.now() + 1000);
      });
    } catch (error) {
      if (isD1QuotaError(error)) {
        await noteD1Failure(this.env, error);
        await this.state.storage.transaction(async storage => {
          await storage.put('job', original);
          await storage.setAlarm(quotaResetAt());
        });
        return;
      }
      job.retries++;
      // 单批反复失败时跳过这一批，避免整条队列被一张坏图永久卡住
      if (job.retries >= 3) { job.failed++; job.cursor += 8; job.retries = 0; }
      await this.state.storage.transaction(async storage => {
        await storage.put('job', job);
        await storage.setAlarm(Date.now() + Math.min(60000, 5000 * 2 ** job.retries));
      });
      console.error('材质净化批处理失败:', error instanceof Error ? error.message : String(error));
    } finally {
      this.executing = false;
    }
  }
}
