import { importPKCS8, SignJWT } from 'jose';
import type { Bindings } from '../env.ts';

type Env = { DB: Bindings['DB']; APP_URL?: string; SEARCH_SUBMISSIONS?: Pick<NonNullable<Bindings['SEARCH_SUBMISSIONS']>, 'sendBatch'> };
export const searchEngines = ['google', 'bing', 'baidu'] as const;
type Engine = typeof searchEngines[number];
export type SearchQueueMessage = { engine: Engine };
type Job = { engine: Engine; texture_id: number; revision: string; attempts: number };

export async function searchConfiguration(env: Env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE locale = '' AND (key LIKE 'search_%' OR key = 'site_url')").all<{ key: string; value: string }>();
  const values = Object.fromEntries(results.map(row => [row.key, row.value]));
  let root = '';
  try {
    const url = new URL(values.site_url || env.APP_URL || '');
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) root = url.origin;
  } catch { root = ''; }
  return { values, root };
}

function enabled(values: Record<string, string>, engine: Engine): boolean {
  return values[`search_${engine}_enabled`] === 'true';
}

async function upsert(env: Env, engine: Engine, id: number) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO search_submissions (engine, texture_id, revision, next_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(engine, texture_id) DO UPDATE SET
    revision = excluded.revision, status = 'pending', attempts = 0, next_at = excluded.next_at,
    http_status = NULL, error = NULL, updated_at = excluded.updated_at`)
    .bind(engine, id, crypto.randomUUID(), now, now).run();
}

export async function queueTextureSubmission(env: Env, id: number): Promise<void> {
  try {
    const { values } = await searchConfiguration(env);
    const texture = await env.DB.prepare("SELECT id FROM textures WHERE id = ? AND visibility = 'public'").bind(id).first();
    if (!texture) await env.DB.prepare("DELETE FROM search_submissions WHERE texture_id = ?").bind(id).run();
    for (const engine of searchEngines) {
      if (!enabled(values, engine)) continue;
      if (engine === 'google') await upsert(env, engine, 0);
      else if (texture) await upsert(env, engine, id);
    }
  } catch {
    console.error('search submission queue failed');
  }
}

export async function queuePublicSubmissions(env: Env): Promise<number> {
  const { values } = await searchConfiguration(env);
  let count = 0;
  for (const engine of searchEngines) {
    if (!enabled(values, engine)) continue;
    if (engine === 'google') { await upsert(env, engine, 0); count++; continue; }
    const now = Date.now();
    const result = await env.DB.prepare(`INSERT INTO search_submissions (engine, texture_id, revision, next_at, updated_at)
      SELECT ?, id, lower(hex(randomblob(16))), ?, ? FROM textures WHERE visibility = 'public'
      ON CONFLICT(engine, texture_id) DO UPDATE SET revision = excluded.revision, status = 'pending',
      attempts = 0, next_at = excluded.next_at, http_status = NULL, error = NULL, updated_at = excluded.updated_at`)
      .bind(engine, now, now).run();
    count += result.meta.changes ?? 0;
  }
  return count;
}

async function post(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    const body = await response.text();
    return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
  }
  finally { clearTimeout(timer); }
}

async function submitGoogle(values: Record<string, string>, root: string): Promise<Response> {
  const account = JSON.parse(values.search_google_credentials || '{}') as { client_email: string; private_key: string };
  const key = await importPKCS8(account.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/webmasters' })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(account.client_email)
    .setAudience('https://oauth2.googleapis.com/token').setIssuedAt().setExpirationTime('5m').sign(key);
  const tokenResponse = await post('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!tokenResponse.ok) return tokenResponse;
  const token = await tokenResponse.json<{ access_token?: string }>();
  if (!token.access_token) throw new Error('invalid_token');
  const property = values.search_google_property || `${root}/`;
  return post(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(`${root}/sitemap.xml`)}`, {
    method: 'PUT', headers: { authorization: `Bearer ${token.access_token}` },
  });
}

export async function dispatchSearchSubmissions(env: Env): Promise<void> {
  if (!env.SEARCH_SUBMISSIONS) return;
  const { values, root } = await searchConfiguration(env);
  if (!root) return;
  const messages: Array<{ body: SearchQueueMessage }> = [];
  for (const engine of searchEngines) {
    if (!enabled(values, engine)) continue;
    const pending = await env.DB.prepare("SELECT 1 FROM search_submissions WHERE engine = ? AND status = 'pending' AND next_at <= ? LIMIT 1").bind(engine, Date.now()).first();
    if (pending) messages.push({ body: { engine } });
  }
  if (messages.length) await env.SEARCH_SUBMISSIONS.sendBatch(messages);
}

export async function processSearchSubmissions(env: Env, onlyEngine?: Engine): Promise<void> {
  const { values, root } = await searchConfiguration(env);
  if (!root) return;
  for (const engine of searchEngines) {
    if (onlyEngine && engine !== onlyEngine) continue;
    if (!enabled(values, engine)) continue;
    const now = Date.now();
    const lease = now + 60_000;
    const claimed = await env.DB.prepare(`UPDATE search_submissions SET next_at = ? WHERE engine = ?
      AND status = 'pending' AND next_at <= ? AND texture_id IN
      (SELECT texture_id FROM search_submissions WHERE engine = ? AND status = 'pending' AND next_at <= ? ORDER BY next_at, texture_id LIMIT 100)
      RETURNING engine, texture_id, revision, attempts`).bind(lease, engine, now, engine, now).all<Job>();
    const jobs = claimed.results;
    if (!jobs.length) continue;
    const current = await env.DB.prepare(`SELECT id FROM textures WHERE visibility = 'public' AND id IN (${jobs.map(() => '?').join(',')})`).bind(...jobs.map(job => job.texture_id)).all<{ id: number }>();
    const publicIds = new Set(current.results.map(row => row.id));
    const active = jobs.filter(job => engine === 'google' || publicIds.has(job.texture_id));
    const inactive = jobs.filter(job => !active.includes(job));
    if (inactive.length) await env.DB.prepare(`DELETE FROM search_submissions WHERE engine = ? AND next_at = ?
      AND EXISTS (SELECT 1 FROM json_each(?) WHERE json_extract(value, '$[0]') = texture_id AND json_extract(value, '$[1]') = revision)`)
      .bind(engine, lease, JSON.stringify(inactive.map(job => [job.texture_id, job.revision]))).run();
    if (!active.length) continue;
    let response: Response | undefined;
    let error: string | null = null;
    try {
      const urls = active.map(job => `${root}/skinlib/${job.texture_id}`);
      if (engine === 'google') response = await submitGoogle(values, root);
      if (engine === 'bing') {
        const key = values.search_bing_key || '';
        if (!/^[a-zA-Z0-9-]{8,128}$/.test(key)) throw new Error('missing_key');
        response = await post('https://www.bing.com/indexnow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: new URL(root).host, key, keyLocation: `${root}/${key}.txt`, urlList: urls }) });
      }
      if (engine === 'baidu') {
        const token = values.search_baidu_token;
        if (!token) throw new Error('missing_token');
        const endpoint = new URL('https://data.zz.baidu.com/urls');
        endpoint.searchParams.set('site', root);
        endpoint.searchParams.set('token', token);
        response = await post(endpoint.href, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: urls.join('\n') });
        if (response.ok) {
          const result = await response.json<{ success?: number; error?: number; not_same_site?: unknown[]; not_valid?: unknown[] }>();
          if (result.error || result.success !== urls.length || result.not_same_site?.length || result.not_valid?.length) error = 'provider_rejected';
        }
      }
      if (!response?.ok) error = `http_${response?.status ?? 0}`;
    } catch { error = 'request_failed'; }
    await env.DB.prepare(`UPDATE search_submissions SET
      status = CASE WHEN ? IS NULL THEN 'submitted' WHEN attempts >= 4 THEN 'failed' ELSE 'pending' END,
      attempts = attempts + 1, next_at = ? + min(3600000, 60000 * (1 << (attempts + 1))),
      http_status = ?, error = ?, updated_at = ? WHERE engine = ? AND next_at = ?
      AND EXISTS (SELECT 1 FROM json_each(?) WHERE json_extract(value, '$[0]') = texture_id AND json_extract(value, '$[1]') = revision)`)
      .bind(error, Date.now(), response?.status ?? null, error, Date.now(), engine, lease, JSON.stringify(active.map(job => [job.texture_id, job.revision]))).run();
  }
}

export async function searchSubmissionStatus(env: Env) {
  const { root, values } = await searchConfiguration(env);
  const counts = await env.DB.prepare('SELECT engine, status, count(*) AS count FROM search_submissions GROUP BY engine, status').all<{ engine: string; status: string; count: number }>();
  const recent = await env.DB.prepare('SELECT engine, texture_id AS textureId, status, attempts, http_status AS httpStatus, error, updated_at AS updatedAt FROM search_submissions ORDER BY updated_at DESC LIMIT 30').all();
  return { root, queueConfigured: !!env.SEARCH_SUBMISSIONS, sitemapUrl: root ? `${root}/sitemap.xml` : '', enabled: Object.fromEntries(searchEngines.map(engine => [engine, enabled(values, engine)])), counts: counts.results, recent: recent.results };
}
