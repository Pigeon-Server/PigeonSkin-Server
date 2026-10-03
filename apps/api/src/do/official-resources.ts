import type { Bindings } from '../env.ts';
import { getSettingBool } from '../lib.ts';
import { ensureOfficialCatalog } from '../services/official-catalog.ts';
import { discoverCapes, discoverDefaultSkins, downloadDefaultSkin, type DefaultSkinPlan, type ResourceCandidate } from '../services/official-sources.ts';
import { applyOfficialUpdates, type SyncState } from '../services/official-updates.ts';

type Phase = 'catalog' | 'skins' | 'skin_downloads' | 'capes' | 'cape_downloads' | 'complete';
interface ResourceJob {
  id: string;
  phase: Phase;
  version: string;
  cursor: number;
  added: number;
  updated: number;
  retries: number;
  failed: boolean;
  skins?: DefaultSkinPlan;
  capes?: ResourceCandidate[];
}
const batchSize = 4;

export class OfficialResourceUpdater {
  private executing = false;
  private readonly state: DurableObjectState;
  private readonly env: Bindings;
  constructor(state: DurableObjectState, env: Bindings) { this.state = state; this.env = env; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/start') return new Response(null, { status: 404 });
    return this.state.blockConcurrencyWhile(async () => {
      const force = url.searchParams.get('force') === 'true';
      if (this.env.OFFICIAL_CATALOG_ENABLED === 'false' || (!force && !await getSettingBool(this.env, 'official_resources_auto_update'))) return new Response(null, { status: 204 });
      let job = await this.state.storage.get<ResourceJob>('job');
      const previous = await this.env.DB.prepare('SELECT * FROM official_resource_sync WHERE id=1').first<SyncState>();
      if ((!job || job.failed) && !force && previous?.checked_at && Date.now() - previous.checked_at < (previous.error ? 3600000 : 86400000)) return new Response(null, { status: 204 });
      if (job && !job.failed) {
        if (!this.executing && await this.state.storage.getAlarm() == null) await this.state.storage.setAlarm(Date.now() + 1000);
        return new Response(null, { status: 202 });
      }
      job = job ? { ...job, failed: false, retries: 0 } : { id: crypto.randomUUID(), phase: 'catalog', version: previous?.client_version || '1.21.4', cursor: 0, added: 0, updated: 0, retries: 0, failed: false };
      await this.state.storage.transaction(async storage => {
        await storage.put('job', job);
        await storage.setAlarm(Date.now() + 1000);
      });
      await this.env.DB.prepare('UPDATE official_resource_sync SET started_at=?,checked_at=?,phase=?,error=NULL WHERE id=1').bind(Date.now(), Date.now(), job.phase).run();
      return new Response(null, { status: 202 });
    });
  }

  async alarm(): Promise<void> {
    this.executing = true;
    try {
      const saved = await this.state.storage.get<ResourceJob>('job');
      if (!saved || saved.failed) return;
      const job = structuredClone(saved);
      try {
        await this.advance(job);
        job.retries = 0;
        await this.env.DB.prepare('UPDATE official_resource_sync SET added=?,updated=?,pending=?,client_version=?,phase=?,error=NULL WHERE id=1').bind(job.added, job.updated, this.pending(job), job.version, job.phase).run();
        if (job.phase === 'complete') {
          await this.env.DB.prepare("UPDATE official_resource_sync SET started_at=NULL,succeeded_at=?,phase='idle' WHERE id=1").bind(Date.now()).run();
          await this.state.storage.delete('job');
        } else {
          await this.state.storage.transaction(async storage => {
            await storage.put('job', job);
            await storage.setAlarm(Date.now() + 1000);
          });
        }
      } catch (failure) {
        saved.retries++;
        saved.failed = saved.retries >= 5;
        await this.state.storage.transaction(async storage => {
          await storage.put('job', saved);
          if (!saved.failed) await storage.setAlarm(Date.now() + Math.min(60000, 5000 * 2 ** (saved.retries - 1)));
        });
        await this.env.DB.prepare('UPDATE official_resource_sync SET error=?,started_at=CASE WHEN ? THEN NULL ELSE started_at END WHERE id=1').bind(failure instanceof Error ? failure.message.slice(0, 500) : 'Resource sync failed', saved.failed ? 1 : 0).run();
      }
    } finally { this.executing = false; }
  }

  private pending(job: ResourceJob) {
    if (job.phase === 'skin_downloads') return (job.skins?.entries.length || 0) - job.cursor;
    if (job.phase === 'cape_downloads') return (job.capes?.length || 0) - job.cursor;
    return 0;
  }

  private async advance(job: ResourceJob) {
    if (job.phase === 'catalog') {
      await ensureOfficialCatalog(this.env);
      await this.env.DB.prepare('DELETE FROM official_resource_batches WHERE job_id<>?').bind(job.id).run();
      job.phase = 'skins';
    } else if (job.phase === 'skins') {
      job.skins = await discoverDefaultSkins(job.version);
      job.cursor = 0;
      if (job.skins.entries.length) job.phase = 'skin_downloads';
      else { job.version = job.skins.version; job.phase = 'capes'; }
    } else if (job.phase === 'skin_downloads') {
      const plan = job.skins!;
      const candidates = await Promise.all(plan.entries.slice(job.cursor, job.cursor + batchSize).map(entry => downloadDefaultSkin(plan, entry)));
      const result = await applyOfficialUpdates(this.env, candidates, { jobId: job.id, key: job.phase + '.' + job.cursor });
      job.added += result.added; job.updated += result.updated; job.cursor += candidates.length;
      if (job.cursor >= plan.entries.length) { job.version = plan.version; delete job.skins; job.phase = 'capes'; job.cursor = 0; }
    } else if (job.phase === 'capes') {
      job.capes = await discoverCapes();
      job.cursor = 0;
      job.phase = job.capes.length ? 'cape_downloads' : 'complete';
    } else if (job.phase === 'cape_downloads') {
      const candidates = job.capes!.slice(job.cursor, job.cursor + batchSize);
      for (const candidate of candidates) if (!candidate.bytes) delete candidate.hash;
      const result = await applyOfficialUpdates(this.env, candidates, { jobId: job.id, key: job.phase + '.' + job.cursor });
      job.added += result.added; job.updated += result.updated; job.cursor += candidates.length;
      if (job.cursor >= job.capes!.length) job.phase = 'complete';
    }
  }
}
