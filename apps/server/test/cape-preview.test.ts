import { beforeAll, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { decodePng, encodePng, previewObjectKey, textureObjectKey } from '@pigeon-skin/minecraft';
import { runMigrations } from './setup.ts';

const hash = 'c'.repeat(64);
beforeAll(async () => {
  await runMigrations();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO textures (hash,name,kind,model,visibility,size_bytes,width,height,created_at,updated_at) VALUES (?,?,'cape',NULL,'public',1,128,64,?,?)").bind(hash, 'Cape', now, now).run();
  const rgba = new Uint8Array(128 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) rgba.set([0, 255, 0, 255], (y * 128 + x) * 4);
  for (let y = 2; y < 34; y++) for (let x = 2; x < 22; x++) rgba.set([200, 0, 0, 255], (y * 128 + x) * 4);
  await env.BUCKET.put(textureObjectKey(hash), await encodePng(128, 64, rgba));
  await env.BUCKET.put(`previews/${hash}.png`, await encodePng(128, 64, new Uint8Array(128 * 64 * 4)));
});

describe('Cape previews', () => {
  it('generates the PHP face crop and bypasses obsolete atlas previews', async () => {
    const response = await SELF.fetch(`https://x/preview/${hash}?render=2`);
    expect(response.status).toBe(200);
    const decoded = await decodePng(new Uint8Array(await response.arrayBuffer()));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect([decoded.image.width, decoded.image.height]).toEqual([125, 200]);
    expect([...decoded.image.rgba.subarray(0, 4)]).toEqual([200, 0, 0, 255]);
    expect([...decoded.image.rgba.subarray(-4)]).toEqual([200, 0, 0, 255]);
    expect(await env.BUCKET.head(previewObjectKey(hash))).not.toBeNull();
    const cached = await SELF.fetch(`https://x/preview/${hash}?render=2`, { headers: { 'if-none-match': response.headers.get('etag')! } });
    expect(cached.status).toBe(304);
  });
});
