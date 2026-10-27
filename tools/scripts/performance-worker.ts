import worker, * as classes from 'pigeon:worker';
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage<any>();
const wrapped = new WeakSet<object>();
const cachedNamespaces = new WeakSet<object>();
const log = console.log;
console.log = (...args: any[]) => { if (!/^(?:<--|-->)/.test(String(args[0]))) log(...args); };

async function withClock<T>(time: number, operation: () => Promise<T>): Promise<T> {
  const RealDate = globalThis.Date;
  if (time) globalThis.Date = class extends RealDate { constructor(value?: string | number) { super(value ?? time); } static now() { return time; } } as DateConstructor;
  try { return await operation(); }
  finally { globalThis.Date = RealDate; }
}

function traceDatabase(db: any, trace: any) {
  const session = db.prepare('SELECT 1').dbSession;
  if (!session || typeof session._sendOrThrow !== 'function') throw new Error('Unsupported local D1 tracing interface');
  if (wrapped.has(session)) return;
  wrapped.add(session);
  const send = session._sendOrThrow;
  session._sendOrThrow = async function (...args: any[]) {
    const owner = context.getStore() ?? { route: 'background', phase: 'background' };
    const started = Date.now();
    try {
      const results = await send.apply(this, args);
      const statements = Array.isArray(args[1]) ? args[1] : [args[1]];
      for (let index = 0; index < statements.length; index++) {
        const result = results[index];
        const sql = String(statements[index]).replace(/\s+/g, ' ').trim();
        const event = { ...owner, timestamp: Date.now(), sql, operation: sql.match(/^\w+/)?.[0]?.toUpperCase(), durationMs: Date.now() - started, rowsRead: result?.meta?.rows_read ?? null, rowsWritten: result?.meta?.rows_written ?? null, success: result?.success !== false };
        await trace.fetch('http://trace/sql', { method: 'POST', body: JSON.stringify(event) });
      }
      return results;
    } catch (error) {
      await trace.fetch('http://trace/sql', { method: 'POST', body: JSON.stringify({ ...owner, timestamp: Date.now(), sql: String(args[1]).replace(/\s+/g, ' '), durationMs: Date.now() - started, success: false, error: String(error).slice(0, 160) }) });
      throw error;
    }
  };
}

function prepare(env: any) {
  traceDatabase(env.DB, env.TRACE);
  if (env.PUBLIC_CACHE && !cachedNamespaces.has(env.PUBLIC_CACHE)) {
    cachedNamespaces.add(env.PUBLIC_CACHE);
    const get = env.PUBLIC_CACHE.get.bind(env.PUBLIC_CACHE);
    env.PUBLIC_CACHE.get = async (...args: any[]) => {
      const value = await get(...args);
      if (String(args[0]).startsWith('pigeon:v1:')) await env.TRACE.fetch('http://trace/cache', { method: 'POST', body: JSON.stringify({ ...context.getStore(), layer: 'kv', hit: value !== null, timestamp: Date.now() }) });
      return value;
    };
  }
  if (env.DIAGNOSTIC_AI) env.AI = { run: async () => { throw Object.assign(new Error('4006: used up your daily free allocation'), { code: 4006 }); } };
  return env;
}

function metadata(request: Request, fallback = 'http') {
  const url = new URL(request.url);
  return { requestId: request.headers.get('x-diagnostic-id') || crypto.randomUUID(), route: `${request.method} ${url.pathname}`, scenario: request.headers.get('x-diagnostic-scenario') || fallback, phase: request.headers.get('x-diagnostic-phase') || 'browser' };
}

function tracedClass(Base: any, name: string) {
  return class extends Base {
    constructor(state: any, env: any) { super(state, prepare(env)); }
    fetch(request: Request) {
      if (new URL(request.url).pathname === '/__diagnostic/alarm') return withClock(Number(new URL(request.url).searchParams.get('time')), async () => { await this.alarm(); return new Response(null, { status: 204 }); });
      return context.run(metadata(request, name), () => super.fetch(request));
    }
    alarm() { return context.run({ route: `alarm:${name}`, phase: 'background', scenario: name }, () => super.alarm()); }
  };
}

export const DerivativeGenerator = tracedClass(classes.DerivativeGenerator, 'derivatives');
export const OfficialResourceUpdater = tracedClass(classes.OfficialResourceUpdater, 'official');
export const TextureSanitizer = tracedClass(classes.TextureSanitizer, 'sanitize');
export const CachePublisher = tracedClass(classes.CachePublisher, 'cache-publisher');
export const Workloads = tracedClass(classes.Workloads, 'workloads');

export default {
  async fetch(request: Request, env: any, ctx: any) {
    prepare(env);
    return context.run(metadata(request), async () => {
      if (new URL(request.url).pathname === '/__diagnostic/queue') {
        let acknowledged = false, retryAfter: number | null = null;
        const body = await request.json();
        await worker.queue({ messages: [{ body, ack() { acknowledged = true; }, retry(options: any) { retryAfter = options?.delaySeconds ?? 0; } }] } as any, env);
        return Response.json({ acknowledged, retryAfter });
      }
      if (new URL(request.url).pathname === '/__diagnostic/scheduled') {
        const pending: Promise<unknown>[] = [];
        const RealDate = globalThis.Date;
        const time = Number(new URL(request.url).searchParams.get('time'));
        if (time) globalThis.Date = class extends RealDate { constructor(value?: string | number) { super(value ?? time); } static now() { return time; } } as DateConstructor;
        try {
          await worker.scheduled({ cron: new URL(request.url).searchParams.get('cron') || '* * * * *' } as any, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
          const results = await Promise.allSettled(pending);
          if (results.some(result => result.status === 'rejected')) return Response.json({ completed: false }, { status: 500 });
          if (new URL(request.url).searchParams.has('alarms')) for (const [binding, id] of [['CACHE_PUBLISHER', 'public-cache'], ['CACHE_PUBLISHER', 'sitemap'], ['TEXTURE_SANITIZER', 'textures'], ['OFFICIAL_RESOURCES', 'official-catalog']]) {
            const namespace = env[binding];
            const response = await namespace.get(namespace.idFromName(id)).fetch(`https://diagnostic/__diagnostic/alarm?time=${time}`);
            await response.arrayBuffer();
            if (!response.ok) return Response.json({ completed: false }, { status: 500 });
          }
        } finally { globalThis.Date = RealDate; }
        return Response.json({ completed: true });
      }
      return worker.fetch(request, env, ctx);
    });
  },
  scheduled(event: any, env: any, ctx: any) { return context.run({ route: `cron:${event.cron}`, phase: 'background' }, () => worker.scheduled(event, prepare(env), ctx)); },
  queue(batch: any, env: any) { return context.run({ route: `queue:${batch.queue}`, phase: 'background' }, () => worker.queue(batch, prepare(env))); },
};
