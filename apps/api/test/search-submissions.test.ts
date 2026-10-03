import { env, SELF, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { runMigrations, makeAdmin } from './setup.ts';
import { invalidateSettingsCache } from '../src/lib.ts';
import { queueTextureSubmission, queuePublicSubmissions, processSearchSubmissions, dispatchSearchSubmissions, searchSubmissionStatus, type SearchQueueMessage } from '../src/services/search-submissions.ts';
import { writeMany } from '../src/services/settings.ts';
import { makePng } from '../../../packages/minecraft/test/png-builder.ts';
import { createApp } from '../src/app.ts';
import type { Bindings } from '../src/env.ts';
import worker from '../src/index.ts';
import type { MessageBatch } from '@cloudflare/workers-types';

const root = 'https://skin.example.com';
const searchEnv = { DB: env.DB, APP_URL: root };
const indexKey = 'indexnow-test-key-1234';
beforeAll(runMigrations);
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM search_submissions').run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'search_%' OR key = 'site_url'").run();
  await configure({ site_url: root });
  invalidateSettingsCache();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => { fetchMock.assertNoPendingInterceptors(); fetchMock.deactivate(); });

async function configure(values: Record<string, string>) {
  await env.DB.batch(Object.entries(values).map(([key, value]) => env.DB.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES (?, '', ?, ?) ON CONFLICT(key, locale) DO UPDATE SET value = excluded.value").bind(key, value, Date.now())));
  invalidateSettingsCache();
}
async function texture(visibility = 'public') {
  const now = Date.now();
  const result = await env.DB.prepare("INSERT INTO textures (hash, kind, model, name, size_bytes, visibility, width, height, created_at, updated_at) VALUES (?, 'skin', 'default', 'Skin', 100, ?, 64, 64, ?, ?)").bind(crypto.randomUUID(), visibility, now, now).run();
  return Number(result.meta.last_row_id);
}
async function adminCookie(role = 'super_admin') {
  const email = `${crypto.randomUUID()}@example.com`;
  const password = 'search-test-password-9';
  const response = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, playerName: `Search${crypto.randomUUID().replaceAll('-', '').slice(0, 9)}` }) });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: number }>();
  await makeAdmin(id);
  if (role !== 'super_admin') await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run();
  const login = await SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
  return login.headers.get('set-cookie')!.split(';')[0]!;
}

describe('search submissions', () => {
  it('deduplicates jobs, excludes private textures, and validates current visibility before sending', async () => {
    await configure({ search_bing_enabled: 'true', search_bing_key: indexKey });
    const id = await texture();
    const privateId = await texture('private');
    await queueTextureSubmission(searchEnv, id);
    await queueTextureSubmission(searchEnv, id);
    await queueTextureSubmission(searchEnv, privateId);
    expect((await searchSubmissionStatus(searchEnv)).recent).toHaveLength(1);
    await env.DB.prepare("UPDATE textures SET visibility = 'private' WHERE id = ?").bind(id).run();
    await processSearchSubmissions(searchEnv);
    expect((await searchSubmissionStatus(searchEnv)).recent).toHaveLength(0);
  });

  it('submits public detail URLs with IndexNow and serves the matching key file', async () => {
    await configure({ search_bing_enabled: 'true', search_bing_key: indexKey });
    const id = await texture();
    await texture('private');
    expect(await queuePublicSubmissions(searchEnv)).toBe(1);
    fetchMock.get('https://www.bing.com').intercept({ path: '/indexnow', method: 'POST', body: JSON.stringify({ host: 'skin.example.com', key: indexKey, keyLocation: `${root}/${indexKey}.txt`, urlList: [`${root}/skinlib/${id}`] }) }).reply(202, '');
    await processSearchSubmissions(searchEnv);
    expect((await searchSubmissionStatus(searchEnv)).recent[0]).toMatchObject({ status: 'submitted', httpStatus: 202 });
    const key = await SELF.fetch(`https://x/${indexKey}.txt`);
    expect(await key.text()).toBe(indexKey);
    expect(key.headers.get('cache-control')).toBe('no-store');
  });

  it('checks Baidu response counts and retries failures without exposing tokens', async () => {
    await configure({ search_baidu_enabled: 'true', search_baidu_token: 'baidu-test-token' });
    const id = await texture();
    await queueTextureSubmission(searchEnv, id);
    fetchMock.get('https://data.zz.baidu.com').intercept({ path: '/urls?site=https%3A%2F%2Fskin.example.com&token=baidu-test-token', method: 'POST', body: `${root}/skinlib/${id}` }).reply(200, { success: 0, remain: 0 });
    await processSearchSubmissions(searchEnv);
    let state = await searchSubmissionStatus(searchEnv);
    expect(state.recent[0]).toMatchObject({ status: 'pending', attempts: 1, error: 'provider_rejected' });
    expect(JSON.stringify(state)).not.toContain('baidu-test-token');
    await env.DB.prepare("UPDATE search_submissions SET next_at = 0, attempts = 4").run();
    fetchMock.get('https://data.zz.baidu.com').intercept({ path: /\/urls\?/, method: 'POST' }).reply(429, '');
    await processSearchSubmissions(searchEnv);
    state = await searchSubmissionStatus(searchEnv);
    expect(state.recent[0]).toMatchObject({ status: 'failed', attempts: 5, httpStatus: 429 });
    await queuePublicSubmissions(searchEnv);
    fetchMock.get('https://data.zz.baidu.com').intercept({ path: /\/urls\?/, method: 'POST' }).reply(200, { success: 1, remain: 100 });
    await processSearchSubmissions(searchEnv);
    expect((await searchSubmissionStatus(searchEnv)).recent[0]).toMatchObject({ status: 'submitted', attempts: 1, error: null });
  });

  it('submits Google Sitemaps through OAuth instead of using the Indexing API', async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const account = { type: 'service_account', client_email: 'search@example.iam.gserviceaccount.com', private_key: await exportPKCS8(pair.privateKey) };
    await configure({ search_google_enabled: 'true', search_google_credentials: JSON.stringify(account), search_google_property: 'sc-domain:example.com' });
    await queueTextureSubmission(searchEnv, await texture());
    await queueTextureSubmission(searchEnv, await texture());
    expect((await searchSubmissionStatus(searchEnv)).recent).toHaveLength(1);
    fetchMock.get('https://oauth2.googleapis.com').intercept({ path: '/token', method: 'POST' }).reply(200, { access_token: 'test-access-token' });
    fetchMock.get('https://www.googleapis.com').intercept({ path: `/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/${encodeURIComponent(`${root}/sitemap.xml`)}`, method: 'PUT', headers: { authorization: 'Bearer test-access-token' } }).reply(204, '');
    await processSearchSubmissions(searchEnv);
    expect((await searchSubmissionStatus(searchEnv)).recent[0]).toMatchObject({ engine: 'google', textureId: 0, status: 'submitted' });
  });

  it('does not submit disabled engines or localhost sites', async () => {
    await queueTextureSubmission(searchEnv, await texture());
    expect(await queuePublicSubmissions(searchEnv)).toBe(0);
    await configure({ site_url: 'http://localhost:5175', search_bing_enabled: 'true', search_bing_key: indexKey });
    await queuePublicSubmissions(searchEnv);
    await processSearchSubmissions(searchEnv);
    expect((await searchSubmissionStatus(searchEnv)).recent[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('claims a queued URL only once when processors overlap', async () => {
    await configure({ search_bing_enabled: 'true', search_bing_key: indexKey });
    await queueTextureSubmission(searchEnv, await texture());
    fetchMock.get('https://www.bing.com').intercept({ path: '/indexnow', method: 'POST' }).reply(200, '');
    await Promise.all([processSearchSubmissions(searchEnv), processSearchSubmissions(searchEnv)]);
    expect((await searchSubmissionStatus(searchEnv)).recent[0]).toMatchObject({ status: 'submitted', attempts: 1 });
  });

  it('accepts a super-admin bulk request without calling external APIs', async () => {
    const cookie = await adminCookie();
    await configure({ search_bing_enabled: 'true', search_bing_key: indexKey });
    const id = await texture();
    await texture('private');
    const ctx = createExecutionContext();
    const response = await createApp().fetch(new Request('https://x/api/v1/admin/search-submissions', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' } }), env as Bindings, ctx);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ queued: 1 });
    await waitOnExecutionContext(ctx);
    expect((await searchSubmissionStatus(searchEnv)).recent).toEqual([expect.objectContaining({ textureId: id, status: 'pending', attempts: 0 })]);
    expect(await env.DB.prepare("SELECT action FROM audit_log WHERE action = 'admin.search.submit'").first()).toBeTruthy();
  });

  it('dispatches engine-level queue messages and submits only from the queue consumer', async () => {
    await configure({ search_bing_enabled: 'true', search_bing_key: indexKey });
    await queueTextureSubmission(searchEnv, await texture());
    const sendBatch = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 32 } } }));
    await dispatchSearchSubmissions({ ...searchEnv, SEARCH_SUBMISSIONS: { sendBatch } });
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(sendBatch).toHaveBeenCalledWith([{ body: { engine: 'bing' } }]);
    expect((await searchSubmissionStatus(searchEnv)).recent[0]).toMatchObject({ status: 'pending', attempts: 0 });
    fetchMock.get('https://www.bing.com').intercept({ path: '/indexnow', method: 'POST' }).reply(200, '');
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue({ messages: [{ body: { engine: 'bing' }, ack, retry }] } as unknown as MessageBatch<SearchQueueMessage>, env as Bindings);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect((await searchSubmissionStatus(searchEnv)).recent[0]).toMatchObject({ status: 'submitted' });
  });

  it('validates credentials, masks admin secrets, and restricts bulk submission to super admins', async () => {
    await expect(writeMany(env, [{ key: 'search_bing_enabled', value: 'true' }], { isSuperAdmin: true })).rejects.toThrow();
    await expect(writeMany(env, [{ key: 'search_bing_key', value: '../invalid' }], { isSuperAdmin: true })).rejects.toThrow();
    await expect(writeMany(env, [{ key: 'search_google_credentials', value: '{}' }], { isSuperAdmin: true })).rejects.toThrow();
    await writeMany(env, [{ key: 'search_bing_key', value: indexKey }], { isSuperAdmin: true });
    const cookie = await adminCookie();
    const settings = await (await SELF.fetch('https://x/api/v1/admin/settings', { headers: { cookie } })).json<{ values: Record<string, string> }>();
    expect(settings.values.search_bing_key).toBe('********');
    expect(await (await SELF.fetch('https://x/api/v1/settings/public')).text()).not.toContain(indexKey);
    const normalAdmin = await adminCookie('admin');
    const response = await SELF.fetch('https://x/api/v1/admin/search-submissions', { method: 'POST', headers: { cookie: normalAdmin, 'sec-fetch-site': 'same-origin' } });
    expect(response.status).toBe(403);
    expect((await SELF.fetch('https://x/api/v1/admin/search-submissions')).status).toBe(401);
  });

  it('queues jobs from the actual upload and visibility-change routes', async () => {
    const cookie = await adminCookie();
    await configure({ search_bing_enabled: 'true', search_bing_key: indexKey });
    const form = new FormData();
    form.set('file', new Blob([makePng({ width: 64, height: 64 })]), 'skin.png');
    form.set('name', 'SearchSkin');
    form.set('kind', 'skin');
    form.set('model', 'default');
    form.set('visibility', 'private');
    const upload = await SELF.fetch('https://x/api/v1/textures', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' }, body: form });
    expect(upload.status).toBe(201);
    const { id } = await upload.json<{ id: number }>();
    expect((await searchSubmissionStatus(searchEnv)).recent).toHaveLength(0);
    const changed = await SELF.fetch(`https://x/api/v1/textures/${id}`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ visibility: 'public' }) });
    expect(changed.status).toBe(200);
    expect((await searchSubmissionStatus(searchEnv)).recent[0]).toMatchObject({ textureId: id, engine: 'bing', status: 'pending' });
  });
});
