import type { Bindings } from '../env.ts';
import { textureObjectKey } from '@pigeon-skin/minecraft';
import { candidateTexture, type ResourceCandidate } from './official-sources.ts';

export interface SyncState { checked_at: number | null; succeeded_at: number | null; started_at: number | null; client_version: string; added: number; updated: number; pending: number; error: string | null; phase: string }
interface ExistingResource { id: number; official_key: string; hash: string; kind: string; model: string | null }

export async function officialResourceStatus(env: Bindings) {
  const state = await env.DB.prepare('SELECT * FROM official_resource_sync WHERE id = 1').first<SyncState>();
  const counts = await env.DB.prepare("SELECT sum(kind='skin') AS skins,sum(kind='cape') AS capes FROM textures WHERE official_key IS NOT NULL").first<{ skins: number; capes: number }>();
  return { checkedAt: state?.checked_at ?? null, succeededAt: state?.succeeded_at ?? null, running: state?.started_at != null, phase: state?.phase || 'idle', clientVersion: state?.client_version || '1.21.4', added: state?.added ?? 0, updated: state?.updated ?? 0, pending: state?.pending ?? 0, error: !!state?.error, skins: counts?.skins || 0, capes: counts?.capes || 0 };
}

export async function applyOfficialUpdates(env: Bindings, candidates: ResourceCandidate[], batch?: { jobId: string; key: string }) {
  if (batch) {
    const applied = await env.DB.prepare('SELECT added,updated FROM official_resource_batches WHERE job_id=? AND batch_key=?').bind(batch.jobId, batch.key).first<{ added: number; updated: number }>();
    if (applied) return applied;
  }
  const rows = (await env.DB.prepare('SELECT id,official_key,hash,kind,model FROM textures WHERE official_key IS NOT NULL').all<ExistingResource>()).results;
  const changed = (candidate: ResourceCandidate) => {
    const current = rows.find(row => row.official_key === candidate.key);
    if (current) return current.hash !== candidate.hash;
    return !rows.some(row => row.hash === candidate.hash && row.kind === candidate.kind && row.model === candidate.model);
  };
  const changes = candidates.filter(changed);
  if (!changes.length) {
    if (batch) await env.DB.prepare('INSERT INTO official_resource_batches (job_id,batch_key,added,updated) VALUES (?,?,0,0)').bind(batch.jobId, batch.key).run();
    return { added: 0, updated: 0 };
  }
  const revision = (await env.DB.prepare('SELECT revision FROM official_catalog_state WHERE id = 1').first<{ revision: number }>())!.revision + 1;
  const downloaded: Awaited<ReturnType<typeof candidateTexture>>[] = []; let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < changes.length) downloaded.push(await candidateTexture(changes[cursor++]!));
  }));
  const verified = downloaded.filter(asset => changed(asset.candidate));
  if (!verified.length) {
    if (batch) await env.DB.prepare('INSERT INTO official_resource_batches (job_id,batch_key,added,updated) VALUES (?,?,0,0)').bind(batch.jobId, batch.key).run();
    return { added: 0, updated: 0 };
  }
  for (const asset of verified) await env.BUCKET.put(textureObjectKey(asset.candidate.hash), asset.bytes, { httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' } });
  const statements = []; const changedIds: number[] = []; const now = Date.now(); let added = 0, updated = 0;
  const replacements = []; const additions = [];
  for (const asset of verified) {
    const existing = rows.find(row => row.official_key === asset.candidate.key);
    if (existing) {
      replacements.push({ id: existing.id, hash: asset.candidate.hash, width: asset.width, height: asset.height, sizeBytes: asset.sizeBytes });
      changedIds.push(existing.id); updated++;
    } else {
      additions.push(asset);
      added++;
    }
  }
  if (replacements.length) {
    const json = JSON.stringify(replacements);
    statements.push(env.DB.prepare("UPDATE textures SET hash=(SELECT json_extract(value,'$.hash') FROM json_each(?) WHERE json_extract(value,'$.id')=textures.id),width=(SELECT json_extract(value,'$.width') FROM json_each(?) WHERE json_extract(value,'$.id')=textures.id),height=(SELECT json_extract(value,'$.height') FROM json_each(?) WHERE json_extract(value,'$.id')=textures.id),size_bytes=(SELECT json_extract(value,'$.sizeBytes') FROM json_each(?) WHERE json_extract(value,'$.id')=textures.id),updated_at=? WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))").bind(json, json, json, json, now, json));
  }
  for (let start = 0; start < additions.length; start += 10) {
    const chunk = additions.slice(start, start + 10);
    statements.push(env.DB.prepare('INSERT INTO textures (official_key,catalog_revision,hash,kind,model,name,size_bytes,width,height,visibility,created_at,updated_at,origin) VALUES ' + chunk.map(() => "(?,?,?,?,?,?,?,?,?,'public',0,?,'repost')").join(','))
      .bind(...chunk.flatMap(asset => [asset.candidate.key, revision, asset.candidate.hash, asset.candidate.kind, asset.candidate.model, asset.candidate.name, asset.sizeBytes, asset.width, asset.height, now])));
  }
  if (changedIds.length) {
    const ids = JSON.stringify(changedIds);
    statements.push(env.DB.prepare('UPDATE players SET updated_at=? WHERE skin_texture_id IN (SELECT value FROM json_each(?)) OR cape_texture_id IN (SELECT value FROM json_each(?))').bind(now, ids, ids));
    statements.push(env.DB.prepare('UPDATE uuid SET version=version+1 WHERE player_id IN (SELECT id FROM players WHERE skin_texture_id IN (SELECT value FROM json_each(?)) OR cape_texture_id IN (SELECT value FROM json_each(?)))').bind(ids, ids));
  }
  statements.push(env.DB.prepare('UPDATE official_catalog_state SET revision=? WHERE id=1').bind(revision));
  if (batch) statements.push(env.DB.prepare('INSERT INTO official_resource_batches (job_id,batch_key,added,updated) VALUES (?,?,?,?)').bind(batch.jobId, batch.key, added, updated));
  await env.DB.batch(statements);
  return { added, updated };
}

export async function syncOfficialResources(env: Bindings, force = false) {
  if (env.OFFICIAL_CATALOG_ENABLED === 'false') return officialResourceStatus(env);
  const updater = env.OFFICIAL_RESOURCES.get(env.OFFICIAL_RESOURCES.idFromName('official-catalog'));
  const response = await updater.fetch('https://official-resources/start?force=' + force, { method: 'POST' });
  if (!response.ok) throw new Error('Official resource updater unavailable');
  await response.arrayBuffer();
  return officialResourceStatus(env);
}
