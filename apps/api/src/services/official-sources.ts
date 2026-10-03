import { inflateRawSync } from 'node:zlib';
import { sha256Hex, validateTexture } from '@pigeon-skin/minecraft';
import type { OfficialTextureAsset } from '@pigeon-skin/shared/official-textures';

export type ResourceCandidate = Omit<OfficialTextureAsset, 'png' | 'width' | 'height' | 'sizeBytes' | 'hash'> & { hash?: string; bytes?: Uint8Array<ArrayBuffer> };
const wiki = 'https://minecraft.wiki/api.php';
const launcherHosts = new Set(['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com']);

async function limitedResponse(response: Response, limit: number) {
  if (!response.ok || !response.body) throw new Error('Official source HTTP ' + response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); throw new Error('Official source exceeds size limit'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  return JSON.parse(new TextDecoder().decode(await limitedResponse(response, 4 * 1024 * 1024))) as T;
}
async function range(url: string, start: number, end: number) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !launcherHosts.has(parsed.hostname)) throw new Error('Invalid official archive host');
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (response.status !== 206) { await response.body?.cancel(); throw new Error('Official archive does not support range requests'); }
  return limitedResponse(response, 4 * 1024 * 1024);
}
export interface ZipEntry { path: string; method: number; compressed: number; size: number; offset: number }
export interface DefaultSkinPlan { version: string; archiveUrl: string; archiveSize: number; entries: ZipEntry[] }
export function zipDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ZipEntry[] = []; let offset = 0;
  while (offset < bytes.length) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid archive directory');
    const name = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    if (offset + 46 + name + extra + comment > bytes.length) throw new Error('Truncated archive directory');
    entries.push({ path: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + name)), method: view.getUint16(offset + 10, true), compressed: view.getUint32(offset + 20, true), size: view.getUint32(offset + 24, true), offset: view.getUint32(offset + 42, true) });
    offset += 46 + name + extra + comment;
  }
  return entries;
}
export async function discoverDefaultSkins(previousVersion: string): Promise<DefaultSkinPlan> {
  const manifest = await json<{ latest: { release: string }; versions: { id: string; url: string }[] }>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const version = manifest.latest.release;
  if (version === previousVersion) return { version, archiveUrl: '', archiveSize: 0, entries: [] };
  const metadataUrl = manifest.versions.find(item => item.id === version)?.url;
  if (!metadataUrl || new URL(metadataUrl).protocol !== 'https:' || !launcherHosts.has(new URL(metadataUrl).hostname)) throw new Error('Official version metadata missing');
  const metadata = await json<{ downloads: { client: { url: string; size: number } } }>(metadataUrl);
  const client = metadata.downloads.client;
  if (!Number.isSafeInteger(client.size) || client.size < 22 || client.size > 1024 * 1024 * 1024) throw new Error('Invalid official archive size');
  const start = Math.max(0, client.size - 65557), tail = await range(client.url, start, client.size - 1);
  const tailView = new DataView(tail.buffer); let eocd = tail.length - 22;
  while (eocd >= 0 && tailView.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Official archive footer missing');
  const directorySize = tailView.getUint32(eocd + 12, true), directoryOffset = tailView.getUint32(eocd + 16, true);
  if (!directorySize || directorySize > 4 * 1024 * 1024 || directoryOffset + directorySize > client.size) throw new Error('Official archive directory too large');
  const directory = zipDirectory(await range(client.url, directoryOffset, directoryOffset + directorySize - 1));
  const selected = directory.filter(entry => /^assets\/minecraft\/textures\/entity\/player\/(wide|slim)\/[a-z0-9_]+\.png$/.test(entry.path));
  if (!selected.length || selected.length > 24) throw new Error('Unexpected default skin count');
  return { version, archiveUrl: client.url, archiveSize: client.size, entries: selected };
}
export async function downloadDefaultSkin(plan: DefaultSkinPlan, entry: ZipEntry): Promise<ResourceCandidate> {
  if (entry.size > 256 * 1024 || entry.compressed > 256 * 1024 || entry.offset < 0 || entry.offset + 30 > plan.archiveSize) throw new Error('Invalid default skin entry size');
  const local = await range(plan.archiveUrl, entry.offset, Math.min(plan.archiveSize - 1, entry.offset + 30 + 65535 + entry.compressed));
  if (local.length < 30) throw new Error('Truncated default skin entry');
  const header = new DataView(local.buffer);
  if (header.getUint32(0, true) !== 0x04034b50) throw new Error('Invalid default skin entry');
  const begin = 30 + header.getUint16(26, true) + header.getUint16(28, true);
  if (begin + entry.compressed > local.length) throw new Error('Truncated default skin data');
  const compressed = local.subarray(begin, begin + entry.compressed);
  const bytes = entry.method === 8 ? Uint8Array.from(inflateRawSync(compressed, { maxOutputLength: 256 * 1024 })) : Uint8Array.from(compressed);
  if (bytes.length !== entry.size || ![0, 8].includes(entry.method)) throw new Error('Invalid default skin size');
  const match = /\/(wide|slim)\/([a-z0-9_]+)\.png$/.exec(entry.path);
  if (!match) throw new Error('Invalid default skin path');
  return { key: 'skin.' + match[2] + '.' + match[1], name: match[2]![0]!.toUpperCase() + match[2]!.slice(1), kind: 'skin', model: match[1] === 'slim' ? 'slim' : 'default', hash: await sha256Hex(bytes), source: plan.archiveUrl + '#' + entry.path, sourcePage: 'https://www.minecraft.net/en-us/article/meet-minecraft-default-skins', bytes };
}

type WikiResponse = { parse?: { wikitext: { '*': string } }; query?: { pages: Record<string, { title: string; revisions?: { slots: { main: { '*': string } } }[] }> } };
export function capePageCandidates(title: string, text: string): ResourceCandidate[] {
  const fields = (text.match(/\|\s*(?:custom-)?texture-id\s*=([^\n]*)/g) || []).join('\n');
  const hashes = [...new Set(fields.match(/[a-f0-9]{48,64}/g) || [])];
  return hashes.map((hash, index) => {
    const name = hashes.length === 1 ? title : title === 'Mojang Cape' ? ['Mojang Cape', 'Classic Mojang Cape'][index]! : title === 'Translator Cape' ? ['Translator Cape', 'Chinese Translator Cape'][index]! : title;
    return { key: 'cape.' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, kind: 'cape', model: null, source: 'https://textures.minecraft.net/texture/' + hash, sourcePage: 'https://minecraft.wiki/w/' + encodeURIComponent(title.replaceAll(' ', '_')) };
  });
}
export async function discoverCapes() {
  const root = await json<WikiResponse>(wiki + '?action=parse&page=Cape&prop=wikitext&format=json');
  const text = root.parse?.wikitext['*'];
  if (!text) throw new Error('Cape index unavailable');
  const start = text.indexOf('=== Ownership capes ==='), end = text.indexOf('=== Announced capes ===');
  if (start < 0 || end < start) throw new Error('Cape index format changed');
  const titles = [...new Set([...text.slice(start, end).matchAll(/\|link=([^|\n]+)/g)].map(match => match[1]!.split('#')[0]!.replaceAll('_',' ').trim()).filter(title => /^[a-z0-9 '’-]+$/i.test(title)))];
  if (!titles.length || titles.length > 80) throw new Error('Unexpected cape index size');
  const candidates: ResourceCandidate[] = [];
  for (let start = 0; start < titles.length; start += 25) {
    const data = await json<WikiResponse>(wiki + '?action=query&redirects=1&prop=revisions&rvprop=content&rvslots=main&format=json&titles=' + encodeURIComponent(titles.slice(start, start + 25).join('|')));
    if (!data.query) throw new Error('Cape metadata unavailable');
    for (const page of Object.values(data.query.pages)) candidates.push(...capePageCandidates(page.title, page.revisions?.[0]?.slots.main['*'] || ''));
  }
  return [...new Map(candidates.map(candidate => [candidate.key, candidate])).values()];
}
export async function candidateTexture(candidate: ResourceCandidate) {
  let bytes = candidate.bytes;
  if (!bytes) {
    const source = new URL(candidate.source);
    if (source.protocol !== 'https:' || source.hostname !== 'textures.minecraft.net' || !/^\/texture\/[a-f0-9]{48,64}$/.test(source.pathname)) throw new Error('Invalid texture source');
    bytes = Uint8Array.from(await limitedResponse(await fetch(source.href, { redirect: 'manual', signal: AbortSignal.timeout(15000) }), 256 * 1024));
  }
  const checked = await validateTexture(bytes, { kind: candidate.kind, model: candidate.model });
  if (!checked.ok || (candidate.hash && checked.value.hash !== candidate.hash)) throw new Error('Official texture verification failed');
  return { candidate: { ...candidate, hash: checked.value.hash }, bytes, ...checked.value.info, sizeBytes: bytes.length };
}
