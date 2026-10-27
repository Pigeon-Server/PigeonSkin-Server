import type { Bindings } from './env.ts';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './user.ts';

export interface D1Usage {
  day: string;
  sampledAt: number;
  rowsRead: number;
  rowsWritten: number;
  accountWide: true;
}
type BudgetEnv = Pick<Bindings, 'DB'> & Partial<Pick<Bindings, 'PUBLIC_CACHE' | 'CACHE_PUBLISHER' | 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_ANALYTICS_TOKEN'>>;
type State = { expiresAt: number; usage: D1Usage | null; pausedUntil: number };
const states = new WeakMap<object, State>();
const attempts = new WeakMap<object, number>();
const day = () => new Date().toISOString().slice(0, 10);
export const quotaResetAt = () => Date.parse(day()) + 86_400_000;

/**
 * 判断是否为 D1 日额度耗尽。
 *
 * 优先看结构化错误码 7500（平台实际返回的形态），再退回文案匹配 ——
 * 只靠正则会漏掉 `{code:7500, message:...}` 这类不含固定措辞的返回，
 * 而「配额错误不推进游标/不计业务失败」的整套设计都依赖这个判断。
 */
export function isD1QuotaError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (typeof current === 'object' && current !== null) {
      const code = (current as { code?: unknown }).code;
      if (code === 7500 || code === '7500') return true;
    }
    const text = String(current);
    if (/exceeded D1.*(?:daily|row read|row write)|D1.*daily.*(?:limit|quota).*exceed|exceeded maximum allowed rows read|daily row (?:read|write) limit/i.test(text)) return true;
    if (/\b7500\b/.test(text) && /D1|rows? read|rows? written|quota|limit/i.test(text)) return true;
    current = typeof current === 'object' && current !== null && 'cause' in current ? current.cause : null;
  }
  return false;
}

export async function readD1Budget(env: BudgetEnv): Promise<State> {
  const existing = states.get(env.DB as object);
  if (existing && (existing.pausedUntil > Date.now() || existing.expiresAt > Date.now())) return existing;
  let usage: D1Usage | null = null, pausedUntil = 0;
  if (env.PUBLIC_CACHE) {
    try {
      const [sample, circuit] = await Promise.all([
        env.PUBLIC_CACHE.get<D1Usage>(`d1:usage:${day()}`, 'json'),
        env.PUBLIC_CACHE.get<{ resetAt: number }>(`d1:circuit:${day()}`, 'json'),
      ]);
      if (sample?.day === day() && Date.now() - sample.sampledAt < 20 * 60_000) usage = sample;
      pausedUntil = circuit?.resetAt ?? 0;
    } catch {}
  }
  const result = { expiresAt: Date.now() + 60_000, usage, pausedUntil };
  states.set(env.DB as object, result);
  return result;
}

export async function noteD1Failure(env: BudgetEnv, error: unknown): Promise<void> {
  if (!isD1QuotaError(error)) return;
  const existing = states.get(env.DB as object);
  if (existing?.pausedUntil && existing.pausedUntil > Date.now()) return;
  states.set(env.DB as object, { expiresAt: quotaResetAt(), usage: existing?.usage ?? null, pausedUntil: quotaResetAt() });
  if (env.CACHE_PUBLISHER) {
    try { await env.CACHE_PUBLISHER.get(env.CACHE_PUBLISHER.idFromName('public-cache')).fetch('https://publisher/quota', { method: 'POST' }); } catch {}
  }
}

export async function backgroundAllowed(env: BudgetEnv): Promise<boolean> {
  const state = await readD1Budget(env);
  return state.pausedUntil <= Date.now() && (!state.usage || usageRatio(state.usage) < 0.7);
}

function usageRatio(usage: D1Usage): number { return Math.max(usage.rowsRead / 5_000_000, usage.rowsWritten / 100_000); }

export function usageBudgetGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const state = await readD1Budget(c.env);
    const retry = String(Math.max(1, Math.ceil((quotaResetAt() - Date.now()) / 1000)));
    if (state.pausedUntil > Date.now()) return c.json({ error: 'common.internal_error' }, 503, { 'Retry-After': retry, 'Cache-Control': 'no-store' });
    const url = new URL(c.req.url);
    const costly = url.pathname.endsWith('/export') || url.pathname === '/api/v1/textures' && (!!url.searchParams.get('keyword') || Number(url.searchParams.get('page')) > 100);
    if (costly && state.usage && usageRatio(state.usage) >= 0.85) return c.json({ error: 'common.rate_limited' }, 429, { 'Retry-After': retry, 'Cache-Control': 'no-store' });
    await next();
  };
}

export async function syncD1Usage(env: BudgetEnv): Promise<void> {
  if (!env.PUBLIC_CACHE || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_ANALYTICS_TOKEN) return;
  if ((attempts.get(env.DB as object) ?? 0) > Date.now()) return;
  attempts.set(env.DB as object, Date.now() + 15 * 60_000);
  const query = 'query Usage($account: string!, $start: Date!, $end: Date!) { viewer { accounts(filter: {accountTag: $account}) { d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: $start, date_leq: $end}) { sum { rowsRead rowsWritten } } } } }';
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { account: env.CLOUDFLARE_ACCOUNT_ID, start: day(), end: day() } }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json<{ data?: { viewer?: { accounts?: Array<{ d1AnalyticsAdaptiveGroups?: Array<{ sum: { rowsRead: number; rowsWritten: number } }> }> } }; errors?: unknown }>();
    const sum = result.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups?.[0]?.sum;
    if (!response.ok || result.errors || !sum || !Number.isFinite(sum.rowsRead) || !Number.isFinite(sum.rowsWritten)) return;
    const usage: D1Usage = { day: day(), sampledAt: Date.now(), rowsRead: sum.rowsRead, rowsWritten: sum.rowsWritten, accountWide: true };
    await env.PUBLIC_CACHE.put(`d1:usage:${day()}`, JSON.stringify(usage), { expirationTtl: 172800 });
    states.delete(env.DB as object);
  } catch {}
}
