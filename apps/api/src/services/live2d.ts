import { Unzip, UnzipInflate } from 'fflate';
import { builtinLive2DModels, type Live2DModelInfo, type Live2DDisplay } from '@pigeon-skin/shared/live2d';
import { fail } from '../framework.ts';
import type { Bindings } from '../env.ts';

const maxArchiveBytes = 20 * 1024 * 1024;
const maxExpandedBytes = 32 * 1024 * 1024;
const maxFiles = 512;
const manifestPrefix = 'live2d/manifests/';
const settingsKey = 'live2d_display';
const types: Record<string, string> = {
  json: 'application/json', moc: 'application/octet-stream', moc3: 'application/octet-stream',
  mtn: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain', md: 'text/plain',
};

function invalid(reason = 'invalid_archive'): never {
  throw fail.invalid('common.invalid_request', { file: `live2d.${reason}` });
}

export function assetType(path: string): string | undefined {
  return types[path.split('.').at(-1)?.toLowerCase() || ''];
}

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 256 && !/[\\\x00-\x1f:%?#]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

function resolveReference(entry: string, reference: unknown, files: Map<string, Uint8Array>): string {
  if (typeof reference !== 'string' || !reference || /[\\\x00-\x1f:%?#]/.test(reference) || reference.startsWith('/')) invalid();
  const parts = entry.split('/').slice(0, -1);
  for (const part of reference.split('/')) {
    if (part === '..') {
      if (!parts.length) invalid();
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  const resolved = parts.join('/');
  if (!files.has(resolved)) invalid('missing_file');
  return resolved;
}

export function unpackModel(bytes: Uint8Array): { files: Map<string, Uint8Array>; entry: string; version: 2 | 4; sizeBytes: number } {
  if (!bytes.length || bytes.length > maxArchiveBytes) invalid('too_large');
  const files = new Map<string, Uint8Array>();
  const finished = new Set<string>();
  let count = 0;
  let total = 0;
  try {
    const unzip = new Unzip(file => {
      if (++count > maxFiles) invalid('too_many_files');
      if (file.name.endsWith('/') || file.name.startsWith('__MACOSX/') || file.name.endsWith('/.DS_Store') || file.name === '.DS_Store') return;
      if (!safePath(file.name) || !assetType(file.name) || files.has(file.name)) invalid();
      if (file.originalSize !== undefined && file.originalSize > maxExpandedBytes) invalid('too_large');
      const chunks: Uint8Array[] = [];
      let size = 0;
      files.set(file.name, new Uint8Array());
      file.ondata = (error, data, final) => {
        if (error) invalid();
        total += data.length;
        size += data.length;
        if (total > maxExpandedBytes || (file.name.endsWith('.json') && size > 1024 * 1024)) invalid('too_large');
        chunks.push(data);
        if (final) {
          const merged = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
          chunks.length = 0;
          files.set(file.name, merged);
          finished.add(file.name);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      unzip.push(bytes.subarray(offset, offset + 65536), offset + 65536 >= bytes.length);
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AppError') throw e;
    invalid();
  }
  if (files.size !== finished.size) invalid();
  const candidates: Array<{ entry: string; version: 2 | 4; json: Record<string, unknown> }> = [];
  for (const [entry, data] of files) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    let json: Record<string, unknown>;
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)); } catch { invalid(); }
    if (!json || typeof json !== 'object' || Array.isArray(json)) invalid();
    if (typeof json.model === 'string' && Array.isArray(json.textures)) candidates.push({ entry, version: 2, json });
    else if (json.Version === 3 && json.FileReferences && typeof json.FileReferences === 'object') candidates.push({ entry, version: 4, json });
  }
  if (candidates.length !== 1) invalid('single_model');
  const { entry, version, json } = candidates[0]!;
  const references = version === 2 ? json : json.FileReferences as Record<string, unknown>;
  const modelFile = resolveReference(entry, version === 2 ? references.model : references.Moc, files);
  if (!modelFile.toLowerCase().endsWith(version === 2 ? '.moc' : '.moc3')) invalid();
  const textures = version === 2 ? references.textures : references.Textures;
  if (!Array.isArray(textures) || !textures.length || textures.length > 16) invalid();
  for (const texture of textures) {
    const path = resolveReference(entry, texture, files);
    if (!/\.(png|jpe?g)$/i.test(path)) invalid();
  }
  function checkReferences(value: unknown, depth = 0) {
    if (depth > 20) invalid();
    if (Array.isArray(value)) { for (const item of value) checkReferences(item, depth + 1); }
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['model', 'physics', 'pose', 'file', 'sound', 'Moc', 'Physics', 'Pose', 'File', 'Sound', 'DisplayInfo', 'UserData'].includes(key)) {
          resolveReference(entry, child, files);
        } else checkReferences(child, depth + 1);
      }
    }
  }
  checkReferences(references);
  return { files, entry, version, sizeBytes: total };
}

export async function getModel(env: Bindings, id: string): Promise<Live2DModelInfo | null> {
  const builtin = builtinLive2DModels.find(model => model.id === id);
  if (builtin) return builtin;
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const object = await env.BUCKET.get(`${manifestPrefix}${id}.json`);
  return object ? object.json<Live2DModelInfo>() : null;
}

export async function readDisplay(env: Bindings): Promise<Live2DDisplay> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ? AND locale = ''").bind(settingsKey).first<{ value: string }>();
  // 看板娘默认禁用：只有管理员在后台显式开启（且模型存在）才下发 enabled
  const config = row ? JSON.parse(row.value) as { enabled: boolean; modelId: string } : { enabled: false, modelId: 'aoba' };
  const model = await getModel(env, config.modelId);
  return { ...config, enabled: config.enabled && !!model, model };
}

export async function listModels(env: Bindings): Promise<Live2DModelInfo[]> {
  const items = [...builtinLive2DModels];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: manifestPrefix, ...(cursor ? { cursor } : {}), limit: 100 });
    for (const object of page.objects) {
      const manifest = await env.BUCKET.get(object.key);
      if (manifest) items.push(await manifest.json<Live2DModelInfo>());
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return items;
}

export async function uploadModel(env: Bindings, name: string, bytes: Uint8Array): Promise<Live2DModelInfo> {
  const { files, entry, version, sizeBytes } = unpackModel(bytes);
  const id = crypto.randomUUID();
  const prefix = `live2d/models/${id}/`;
  const keys: string[] = [];
  const info: Live2DModelInfo = { id, name, version, sizeBytes, builtin: false, url: `/api/v1/live2d/assets/${id}/${entry.split('/').map(encodeURIComponent).join('/')}` };
  try {
    for (const [path, bytes] of files) {
      const key = prefix + path;
      keys.push(key);
      await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: assetType(path)! } });
    }
    keys.push(`${manifestPrefix}${id}.json`);
    await env.BUCKET.put(`${manifestPrefix}${id}.json`, JSON.stringify(info), { httpMetadata: { contentType: 'application/json' } });
  } catch (e) {
    await env.BUCKET.delete(keys);
    throw e;
  }
  return info;
}

export async function saveDisplay(env: Bindings, enabled: boolean, modelId: string): Promise<Live2DDisplay> {
  const model = await getModel(env, modelId);
  if (!model) throw fail.notFound();
  await env.DB.prepare("INSERT INTO settings (key, locale, value, updated_at) VALUES (?, '', ?, ?) ON CONFLICT(key, locale) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(settingsKey, JSON.stringify({ enabled, modelId }), Date.now()).run();
  return { enabled, modelId, model };
}
