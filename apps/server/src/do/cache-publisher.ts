import type { Bindings } from '../core/env.ts';
import { withRequestCache } from '../core/request-cache.ts';
import { publicCacheRevision } from '../core/public-cache.ts';
import { quotaResetAt, isD1QuotaError } from '../core/usage-budget.ts';
import { backgroundAllowed, noteD1Failure } from '../core/usage-budget.ts';
import { publishSitemap } from '../services/sitemap-publication.ts';
import type { TaskRun } from '../services/task-runs.ts';
import { createDb, taskRuns } from '@pigeon-skin/db';
import { desc } from 'drizzle-orm';

type Publication = { key: string; scopes: string[]; envelope: { version: string; publishedAt: number; data: unknown } };
type Pending = { key: string; parts: number; attempts: number; nextAttemptAt?: number };

export class CachePublisher {
  private readonly state: DurableObjectState;
  private readonly env: Bindings;
  private busy = false;
  constructor(state: DurableObjectState, env: Bindings) { this.state = state; this.env = env; }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 25_000;
    while (this.busy) {
      if (Date.now() >= deadline) throw new Error('Publisher busy');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    this.busy = true;
    try { return await operation(); }
    finally { this.busy = false; }
  }

  private async enqueueRequest(operation: () => Promise<Response>): Promise<Response> {
    try { return await this.enqueue(operation); }
    catch (error) {
      const local = { ...this.env };
      delete local.CACHE_PUBLISHER;
      await noteD1Failure(local, error).catch(() => {});
      if (isD1QuotaError(error)) await this.publishQuota().catch(() => {});
      return new Response(null, { status: 503 });
    }
  }

  private async publishQuota(): Promise<void> {
    if (!this.env.PUBLIC_CACHE) return;
    const day = new Date().toISOString().slice(0, 10);
    if (await this.state.storage.get('quota-day') === day) return;
    await this.env.PUBLIC_CACHE.put(`d1:circuit:${day}`, JSON.stringify({ resetAt: quotaResetAt() }), { expirationTtl: 172800 });
    await this.state.storage.put('quota-day', day);
  }

  private async scheduleAt(target: number): Promise<void> {
    await this.state.storage.transaction(async storage => {
      const current = await storage.getAlarm();
      if (current == null || target < current) await storage.setAlarm(target);
    });
  }

  private async scheduleBudgetReset(target: number): Promise<void> {
    await this.state.storage.transaction(async storage => {
      const current = await storage.getAlarm();
      const dirty = await storage.get<boolean>('sitemap-dirty');
      if (!dirty || current == null || target < current) await storage.setAlarm(target);
    });
  }

  private async taskHistory(): Promise<TaskRun[]> {
    if (!await this.state.storage.get('task-history-initialized')) {
      const rows = await createDb(this.env.DB).select().from(taskRuns).orderBy(desc(taskRuns.ranAt), desc(taskRuns.id)).limit(50);
      await this.state.storage.put({ 'task-runs': rows, 'task-sequence': Math.max(0, ...rows.map(row => row.id)), 'task-history-initialized': true });
      return rows;
    }
    return await this.state.storage.get<TaskRun[]>('task-runs') ?? [];
  }

  fetch(request: Request): Promise<Response> { return withRequestCache(() => this.handleRequest(request)); }

  private async handleRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/task-runs') {
      if (request.method === 'GET') return this.enqueueRequest(async () => Response.json(await this.taskHistory()));
      if (request.method === 'POST') {
        const entry = await request.json<Omit<TaskRun, 'id'>>();
        return this.enqueueRequest(async () => {
          const rows = await this.taskHistory();
          const id = (await this.state.storage.get<number>('task-sequence') ?? 0) + 1;
          const items = [...rows, { ...entry, id }].sort((a, b) => b.ranAt - a.ranAt || b.id - a.id).slice(0, 50);
          await this.state.storage.put({ 'task-runs': items, 'task-sequence': id });
          return new Response(null, { status: 204 });
        });
      }
    }
    if (request.method !== 'POST') return new Response(null, { status: 404 });
    if (new URL(request.url).pathname === '/sitemap/refresh') {
      await this.state.storage.transaction(async storage => {
        const version = await storage.get<number>('sitemap-dirty-version') ?? 0;
        await storage.put({ 'sitemap-dirty': true, 'sitemap-dirty-version': version + 1 });
      });
      const last = await this.state.storage.get<number>('sitemap-published') ?? 0;
      const target = await backgroundAllowed(this.env) ? Math.max(Date.now() + 60_000, last + 300_000) : quotaResetAt();
      await this.scheduleAt(target);
      return new Response(null, { status: 202 });
    }
    if (new URL(request.url).pathname === '/sitemap/build') return this.enqueueRequest(async () => {
      const done = await publishSitemap(this.env);
      return new Response(null, { status: done ? 204 : 503 });
    });
    if (!this.env.PUBLIC_CACHE) return new Response(null, { status: 404 });
    if (new URL(request.url).pathname === '/quota') return this.enqueueRequest(async () => {
      await this.publishQuota();
      return new Response(null, { status: 204 });
    });
    if (new URL(request.url).pathname !== '/publish') return new Response(null, { status: 404 });
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 24 * 1024 * 1024) return new Response(null, { status: 413 });
    const publication = JSON.parse(text) as Publication;
    return this.enqueueRequest(async () => {
      if (await publicCacheRevision(this.env, publication.scopes) !== publication.envelope.version) return new Response(null, { status: 409 });
      const id = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publication.key));
      const key = [...new Uint8Array(id)].map(value => value.toString(16).padStart(2, '0')).join('');
      const last = await this.state.storage.get<{ version: string; at: number }>(`published:${key}`);
      if (last?.version === publication.envelope.version && Date.now() - last.at < 60_000) return new Response(null, { status: 204 });
      if (!(await this.state.storage.get(`pending:${key}`)) && (await this.state.storage.list({ prefix: 'pending:', limit: 128 })).size >= 128) return new Response(null, { status: 429 });
      const parts = Math.ceil(text.length / 250_000);
      const pending: Pending = { key, parts, attempts: 0 };
      await this.state.storage.transaction(async storage => {
        const previous = await storage.get<Pending>(`pending:${key}`);
        if (previous && previous.parts > parts) await storage.delete(Array.from({ length: previous.parts - parts }, (_, index) => `${key}:${parts + index}`));
        for (let index = 0; index < parts; index++) await storage.put(`${key}:${index}`, text.slice(index * 250_000, (index + 1) * 250_000));
        await storage.put(`pending:${key}`, pending);
        const alarm = await storage.getAlarm();
        if (alarm == null || Date.now() + 60_000 < alarm) await storage.setAlarm(Date.now() + 60_000);
      });
      await this.publish(pending);
      return new Response(null, { status: 202 });
    });
  }

  private async publish(pending: Pending): Promise<void> {
    if ((pending.nextAttemptAt ?? 0) > Date.now()) return;
    const chunks = await this.state.storage.get<string>(Array.from({ length: pending.parts }, (_, index) => `${pending.key}:${index}`));
    const text = Array.from({ length: pending.parts }, (_, index) => chunks.get(`${pending.key}:${index}`) ?? '').join('');
    const publication = JSON.parse(text) as Publication;
    const discard = async () => { await this.state.storage.delete([`pending:${pending.key}`, ...Array.from({ length: pending.parts }, (_, index) => `${pending.key}:${index}`)]); };
    if (await publicCacheRevision(this.env, publication.scopes) !== publication.envelope.version) { await discard(); return; }
    const day = new Date().toISOString().slice(0, 10);
    const budget = await this.state.storage.get<{ day: string; writes: number }>('budget');
    const writes = budget?.day === day ? budget.writes : 0;
    if (writes >= 800) { await this.scheduleBudgetReset(Date.parse(day) + 86_400_000); return; }
    const lastWrite = await this.state.storage.get<number>(`last:${pending.key}`) ?? 0;
    if (Date.now() - lastWrite < 1100) return;
    await this.state.storage.put('budget', { day, writes: writes + 1 });
    try {
      await this.env.PUBLIC_CACHE!.put(publication.key, JSON.stringify(publication.envelope));
      await this.state.storage.put({ [`last:${pending.key}`]: Date.now(), [`published:${pending.key}`]: { version: publication.envelope.version, at: Date.now() } });
      await discard();
    } catch {
      pending.attempts++;
      pending.nextAttemptAt = Date.now() + Math.min(360, 2 ** Math.min(pending.attempts, 9)) * 60_000;
      await this.state.storage.put(`pending:${pending.key}`, pending);
    }
  }

  alarm(): Promise<void> { return withRequestCache(() => this.handleAlarm()); }

  private async handleAlarm(): Promise<void> {
    try { await this.enqueue(async () => {
      if (await this.state.storage.get('sitemap-dirty')) {
        if (!await backgroundAllowed(this.env)) { await this.scheduleAt(quotaResetAt()); return; }
        const last = await this.state.storage.get<number>('sitemap-published') ?? 0;
        if (last + 300_000 > Date.now()) { await this.scheduleAt(last + 300_000); return; }
        const dirtyVersion = await this.state.storage.get<number>('sitemap-dirty-version') ?? 0;
        try {
          if (await publishSitemap(this.env)) await this.state.storage.transaction(async storage => {
            const current = await storage.get<number>('sitemap-dirty-version') ?? 0;
            await storage.put({ 'sitemap-dirty': current !== dirtyVersion, 'sitemap-published': Date.now() });
            if (current !== dirtyVersion) {
              const alarm = await storage.getAlarm();
              if (alarm == null || Date.now() + 300_000 < alarm) await storage.setAlarm(Date.now() + 300_000);
            }
          });
          else { await this.scheduleAt(Date.now() + 60_000); return; }
        } catch (error) {
          const local = { ...this.env };
          delete local.CACHE_PUBLISHER;
          await noteD1Failure(local, error);
          if (isD1QuotaError(error)) await this.publishQuota().catch(() => {});
          await this.scheduleAt(isD1QuotaError(error) ? quotaResetAt() : Date.now() + 300_000);
          return;
        }
      }
      const day = new Date().toISOString().slice(0, 10);
      const budget = await this.state.storage.get<{ day: string; writes: number }>('budget');
      if (budget?.day === day && budget.writes >= 800) { await this.scheduleBudgetReset(Date.parse(day) + 86_400_000); return; }
      const pending = await this.state.storage.list<Pending>({ prefix: 'pending:', limit: 128 });
      const due = [...pending.values()].filter(job => (job.nextAttemptAt ?? 0) <= Date.now()).sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0)).slice(0, 16);
      for (const job of due) {
        try { await this.publish(job); }
        catch (error) {
          if (isD1QuotaError(error)) { await this.scheduleAt(quotaResetAt()); return; }
          job.attempts++;
          await this.state.storage.put(`pending:${job.key}`, job);
        }
      }
      if ((await this.state.storage.list({ prefix: 'pending:', limit: 1 })).size) await this.scheduleAt(Date.now() + 60_000);
    }); } catch (error) {
      await this.scheduleAt(Date.now() + 60_000);
      throw error;
    }
  }
}
