import type { Bindings } from './env.ts';
import { bumpCacheGeneration } from './cache-generation.ts';
import { missingSnapshotSchema } from './settings-snapshot.ts';
import { isD1QuotaError, noteD1Failure, readD1Budget } from './usage-budget.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { requestPending } from './request-cache.ts';

export type PublicCacheEnv = Pick<Bindings, 'DB'> & Partial<Pick<Bindings, 'PUBLIC_CACHE' | 'CACHE_PUBLISHER' | 'APP_URL'>>;
type Envelope<T> = { version: string; publishedAt: number; data: T };
type Entry = { value: unknown; version: string | null; expiresAt: number; generation: number };
const memory = new WeakMap<object, Map<string, Entry>>();
let generation = 0;
const refreshing = new AsyncLocalStorage<ReadonlySet<string>>();

export function invalidatePublicCache(): void { generation++; }

export async function publicCacheRevision(env: Pick<Bindings, 'DB'>, scopes: readonly string[]): Promise<string | null> {
  try {
    const rows = await env.DB.prepare(`SELECT scope,version FROM public_cache_versions WHERE scope IN (${scopes.map(() => '?').join(',')}) ORDER BY scope`).bind(...scopes).all<{ scope: string; version: number }>();
    return rows.results.length === scopes.length ? rows.results.map(row => `${row.scope}:${row.version}`).join('|') : null;
  } catch (error) { if (missingSnapshotSchema(error)) return null; throw error; }
}

export async function readPublicCache<T>(env: PublicCacheEnv, key: string, scopes: readonly string[], load: () => Promise<T>, maxAge = 300_000, retryOnChange = true): Promise<T> {
  if (scopes.some(scope => refreshing.getStore()?.has(scope))) return load();
  if (!env.PUBLIC_CACHE) return load();
  const db = env.DB as object;
  const cacheKey = `v1:${env.APP_URL ?? ''}:${key}`;
  const cached = memory.get(db)?.get(cacheKey);
  const strict = scopes.includes('textures') || scopes.includes('discovery');
  if (!strict && cached && cached.expiresAt > Date.now() && cached.generation === generation) return cached.value as T;
  const bucket = requestPending('public', db);
  const existing = bucket.get(cacheKey);
  if (existing) return existing as Promise<T>;
  const currentGeneration = generation;
  const origin = () => refreshing.run(new Set([...(refreshing.getStore() ?? []), ...scopes]), load);
  const pending = (async () => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cacheKey));
    const storageKey = 'pigeon:v1:' + [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
    let published: Envelope<T> | null = null;
    try { published = await env.PUBLIC_CACHE!.get<Envelope<T>>(storageKey, 'json'); } catch {}
    let value: T;
    let sourceVersion: string | null = published?.version ?? null;
    if (!strict && published && ((currentGeneration === 0 && Date.now() - published.publishedAt < maxAge) || (await readD1Budget(env)).pausedUntil > Date.now())) value = published.data;
    else {
      try {
      let version = await publicCacheRevision(env, scopes);
      sourceVersion = version;
      if (strict && version !== null && cached?.version === version && cached.generation === currentGeneration && cached.expiresAt > Date.now()) return cached.value as T;
      if (published && version !== null && published.version === version) value = published.data;
      else {
        bumpCacheGeneration();
        value = await origin();
        const latest = await publicCacheRevision(env, scopes);
        if (latest !== version && retryOnChange) {
          bumpCacheGeneration();
          value = await origin();
          version = latest;
          sourceVersion = latest;
        }
        else if (latest !== version) { version = null; sourceVersion = null; }
        if (version !== null && await publicCacheRevision(env, scopes) === version) {
          const envelope: Envelope<T> = { version, publishedAt: Date.now(), data: value };
          try {
            if (env.CACHE_PUBLISHER) {
              const publisher = env.CACHE_PUBLISHER.get(env.CACHE_PUBLISHER.idFromName('public-cache'));
              await publisher.fetch('https://publisher/publish', { method: 'POST', body: JSON.stringify({ key: storageKey, scopes, envelope }) });
            }
          } catch {}
        }
      }
      } catch (error) {
        if (!published || strict || !isD1QuotaError(error)) throw error;
        await noteD1Failure(env, error);
        value = published.data;
      }
    }
    const bucket = memory.get(db) ?? new Map<string, Entry>();
    if (bucket.size >= 256) bucket.delete(bucket.keys().next().value!);
    bucket.set(cacheKey, { value, version: sourceVersion, expiresAt: Date.now() + 60_000, generation: currentGeneration });
    memory.set(db, bucket);
    return value;
  })();
  bucket.set(cacheKey, pending);
  try { return await pending; }
  finally { bucket.delete(cacheKey); }
}
