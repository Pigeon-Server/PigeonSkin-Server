import { currentCacheGeneration } from './cache-generation.ts';
import type { Bindings } from './env.ts';
import { requestPending } from './request-cache.ts';

type Snapshot = { values: Record<string, string>; expiresAt: number; generation: number };
const snapshots = new WeakMap<object, Map<string, Snapshot>>();

export function missingSnapshotSchema(error: unknown): boolean {
  return /(?:no such table|does not exist|doesn't exist).*?(?:settings_snapshots|public_cache_versions|site_stats|texture_counts)|(?:settings_snapshots|public_cache_versions|site_stats|texture_counts).*?(?:does not exist|doesn't exist)/i.test(String(error));
}

export async function readSettingsSnapshot(env: Pick<Bindings, 'DB'>, locale = ''): Promise<Record<string, string>> {
  const db = env.DB as object;
  const generation = currentCacheGeneration();
  const existing = snapshots.get(db)?.get(locale);
  if (existing && existing.expiresAt > Date.now() && existing.generation === generation) return existing.values;
  const bucket = requestPending('snapshots', db);
  const inflight = bucket.get(locale);
  if (inflight) return inflight as Promise<Record<string, string>>;
  const load = (async () => {
    let values: Record<string, string>;
    try {
      const row = await env.DB.prepare('SELECT value FROM settings_snapshots WHERE locale=?').bind(locale).first<{ value: string }>();
      values = row ? JSON.parse(row.value) as Record<string, string> : {};
    } catch (error) {
      if (!missingSnapshotSchema(error)) throw error;
      const rows = await env.DB.prepare('SELECT key,value FROM settings WHERE locale=?').bind(locale).all<{ key: string; value: string }>();
      values = Object.fromEntries(rows.results.map(row => [row.key, row.value]));
    }
    const bucket = snapshots.get(db) ?? new Map<string, Snapshot>();
    bucket.set(locale, { values, generation, expiresAt: Date.now() + 60_000 });
    snapshots.set(db, bucket);
    return values;
  })();
  bucket.set(locale, load);
  try { return await load; }
  finally { bucket.delete(locale); }
}
