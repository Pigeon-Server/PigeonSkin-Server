import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { env, fetchMock, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { encodePng, sha256Hex } from '@pigeon-skin/minecraft';
import { officialTextures } from '@pigeon-skin/shared/official-textures';
import { Buffer } from 'node:buffer';
import type { Bindings } from '../src/env.ts';
import { OfficialResourceUpdater } from '../src/do/official-resources.ts';
import { applyOfficialUpdates, officialResourceStatus } from '../src/services/official-updates.ts';
import { ensureOfficialCatalog, resetOfficialCatalogCache } from '../src/services/official-catalog.ts';
import type { ResourceCandidate } from '../src/services/official-sources.ts';
import { runMigrations } from './setup.ts';

const bindings = env as unknown as Bindings;
const configured = () => ({ ...bindings, OFFICIAL_CATALOG_ENABLED: 'true' });
const stub = () => bindings.OFFICIAL_RESOURCES.get(bindings.OFFICIAL_RESOURCES.idFromName('official-catalog'));
beforeAll(runMigrations);
// isolatedStorage 每用例重置存储但复用 env.DB；官方目录完成态缓存要一并失效，
// 否则上一用例的缓存让本用例的 ensureOfficialCatalog 跳过初始化
beforeEach(() => { resetOfficialCatalogCache(bindings.DB); fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(async () => {
  await runInDurableObject(stub(), async (_instance, state) => { await state.storage.deleteAlarm(); await state.storage.delete('job'); });
  fetchMock.assertNoPendingInterceptors(); fetchMock.deactivate();
});
async function start(force = true) {
  return runInDurableObject(stub(), async (_instance, state) => {
    const updater = new OfficialResourceUpdater(state, configured());
    return (await updater.fetch(new Request('https://updater/start?force=' + force, { method: 'POST' }))).status;
  });
}
async function savedJob() { return runInDurableObject(stub(), (_instance, state) => state.storage.get<Record<string, unknown>>('job')); }
async function advanceAlarm() {
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
    await new OfficialResourceUpdater(state, configured()).alarm();
  });
}
async function seedJob(phase: string, extra: Record<string, unknown> = {}) {
  await env.DB.prepare('UPDATE official_resource_sync SET started_at=?,checked_at=?,phase=? WHERE id=1').bind(Date.now(), Date.now(), phase).run();
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.put('job', { id: 'test-job', phase, version: '1.21.4', cursor: 0, added: 0, updated: 0, retries: 0, failed: false, ...extra });
    await state.storage.setAlarm(Date.now() + 60000);
  });
}
async function candidates(count: number) {
  const result: { candidate: ResourceCandidate; bytes: Uint8Array<ArrayBuffer> }[] = [];
  for (let index = 0; index < count; index++) {
    const rgba = new Uint8Array(64 * 32 * 4).fill(128 + index);
    const bytes = Uint8Array.from(await encodePng(64, 32, rgba)), hash = await sha256Hex(bytes);
    result.push({ candidate: { key: 'cape.job-' + index, name: 'Job Cape ' + index, kind: 'cape', model: null, hash, source: 'https://textures.minecraft.net/texture/' + hash, sourcePage: '' }, bytes });
  }
  return result;
}

describe('durable official resource jobs', () => {
  it('enqueues immediately without downloading and deduplicates concurrent starts', async () => {
    expect(await start()).toBe(202);
    const first = await savedJob();
    expect(first?.phase).toBe('catalog');
    expect(await Promise.all([start(), start()])).toEqual([202, 202]);
    expect((await savedJob())?.id).toBe(first?.id);
    expect((await officialResourceStatus(bindings)).running).toBe(true);
    expect(await runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm())).not.toBeNull();
  });
  it('honors daily scheduling without suppressing a manual check', async () => {
    await env.DB.prepare('UPDATE official_resource_sync SET checked_at=? WHERE id=1').bind(Date.now()).run();
    expect(await start(false)).toBe(204);
    expect(await savedJob()).toBeUndefined();
    expect(await start(true)).toBe(202);
  });
  it('processes only four downloads per alarm and resumes using stored progress', async () => {
    await ensureOfficialCatalog(configured());
    const assets = await candidates(5);
    await seedJob('cape_downloads', { capes: assets.map(asset => asset.candidate) });
    for (const asset of assets.slice(0, 4)) fetchMock.get('https://textures.minecraft.net').intercept({ path: '/texture/' + asset.candidate.hash }).reply(200, Buffer.from(asset.bytes));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await env.DB.prepare('SELECT error FROM official_resource_sync WHERE id=1').first()).toEqual({ error: null });
    expect(await savedJob()).toMatchObject({ cursor: 4, added: 4, phase: 'cape_downloads' });
    expect(await officialResourceStatus(bindings)).toMatchObject({ running: true, pending: 1, added: 4 });
    const last = assets[4]!;
    fetchMock.get('https://textures.minecraft.net').intercept({ path: '/texture/' + last.candidate.hash }).reply(200, Buffer.from(last.bytes));
    await advanceAlarm();
    expect(await savedJob()).toBeUndefined();
    expect(await officialResourceStatus(bindings)).toMatchObject({ running: false, pending: 0, added: 5, error: false, capes: 60 });
  });
  it('retains the failed batch and retries without repeating successful batches', async () => {
    await ensureOfficialCatalog(configured());
    const [asset] = await candidates(1);
    await seedJob('cape_downloads', { cursor: 4, added: 4, capes: [...Array.from({ length: 4 }, () => officialTextures.find(item => item.kind === 'cape')!), asset!.candidate] });
    fetchMock.get('https://textures.minecraft.net').intercept({ path: '/texture/' + asset!.candidate.hash }).reply(503, '');
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await savedJob()).toMatchObject({ cursor: 4, added: 4, retries: 1, failed: false });
    expect(await officialResourceStatus(bindings)).toMatchObject({ running: true, error: true });
    fetchMock.get('https://textures.minecraft.net').intercept({ path: '/texture/' + asset!.candidate.hash }).reply(200, Buffer.from(asset!.bytes));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await officialResourceStatus(bindings)).toMatchObject({ running: false, error: false, added: 5 });
  });
  it('reuses a committed batch after an interrupted checkpoint without another download', async () => {
    await ensureOfficialCatalog(configured());
    const [asset] = await candidates(1);
    const committed = await applyOfficialUpdates(configured(), [{ ...asset!.candidate, bytes: asset!.bytes }], { jobId: 'test-job', key: 'cape_downloads.0' });
    expect(committed).toEqual({ added: 1, updated: 0 });
    await seedJob('cape_downloads', { capes: [asset!.candidate] });
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await officialResourceStatus(bindings)).toMatchObject({ running: false, added: 1, error: false, capes: 56 });
  });
  it('keeps exhausted jobs resumable and does not leave them running forever', async () => {
    await seedJob('skins', { retries: 4 });
    fetchMock.get('https://piston-meta.mojang.com').intercept({ path: '/mc/game/version_manifest_v2.json' }).reply(503, '');
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const previous = await savedJob();
    expect(previous).toMatchObject({ failed: true, retries: 5, phase: 'skins' });
    expect(await officialResourceStatus(bindings)).toMatchObject({ running: false, error: true });
    expect(await start()).toBe(202);
    expect(await savedJob()).toMatchObject({ id: previous?.id, failed: false, retries: 0, phase: 'skins' });
  });
});
