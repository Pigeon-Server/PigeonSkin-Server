import type { Bindings } from '../env.ts';
import { textureObjectKey } from '@pigeon-skin/minecraft';
import { OFFICIAL_CATALOG_REVISION as revision } from '@pigeon-skin/shared/official-textures';
const initializing = new WeakMap<Bindings['DB'], Promise<void>>();

async function initialize(env: Pick<Bindings, 'DB' | 'BUCKET'>) {
  const current = await env.DB.prepare('SELECT revision FROM official_catalog_state WHERE id = 1').first<{ revision: number }>();
  if (current && current.revision >= revision) return;
  const { officialTextures } = await import('@pigeon-skin/shared/official-textures');
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < officialTextures.length) {
      const asset = officialTextures[cursor++]!;
      const bytes = Uint8Array.from(atob(asset.png), character => character.charCodeAt(0));
      await env.BUCKET.put(textureObjectKey(asset.hash), bytes, { httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' } });
    }
  }));
  const statements = [];
  for (let start = 0; start < officialTextures.length; start += 10) {
    const batch = officialTextures.slice(start, start + 10);
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO textures (official_key,catalog_revision,hash,kind,model,name,size_bytes,width,height,visibility,likes,created_at,updated_at,uploader_id,origin) VALUES ' + batch.map(() => "(?,?,?,?,?,?,?,?,?,'public',0,0,0,NULL,'repost')").join(','))
      .bind(...batch.flatMap(asset => [asset.key, revision, asset.hash, asset.kind, asset.model, asset.name, asset.sizeBytes, asset.width, asset.height])));
  }
  statements.push(env.DB.prepare('INSERT INTO official_catalog_state (id,revision) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision').bind(revision));
  await env.DB.batch(statements);
}

export async function ensureOfficialCatalog(env: Pick<Bindings, 'DB' | 'BUCKET' | 'OFFICIAL_CATALOG_ENABLED'>) {
  if (env.OFFICIAL_CATALOG_ENABLED === 'false') return;
  let pending = initializing.get(env.DB);
  if (!pending) {
    pending = initialize(env).finally(() => initializing.delete(env.DB));
    initializing.set(env.DB, pending);
  }
  await pending;
}

export async function ensureDefaultCloset(env: Pick<Bindings, 'DB' | 'OFFICIAL_CATALOG_ENABLED'>, userId: number) {
  if (env.OFFICIAL_CATALOG_ENABLED === 'false') return;
  const current = await env.DB.prepare('SELECT revision FROM user_default_catalog WHERE user_id = ?').bind(userId).first<{ revision: number }>();
  const latest = await env.DB.prepare('SELECT revision FROM official_catalog_state WHERE id = 1').first<{ revision: number }>();
  const target = latest?.revision ?? revision;
  if (current && current.revision >= target) return;
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO user_default_catalog (user_id,revision) VALUES (?,0)').bind(userId),
    env.DB.prepare('UPDATE textures SET likes = likes + 1 WHERE official_key IS NOT NULL AND catalog_revision > (SELECT revision FROM user_default_catalog WHERE user_id = ?) AND NOT EXISTS (SELECT 1 FROM closet WHERE user_id = ? AND texture_id = textures.id)').bind(userId, userId),
    env.DB.prepare("INSERT OR IGNORE INTO closet (user_id,texture_id,item_name,created_at,is_default) SELECT ?,id,name,0,1 FROM textures WHERE official_key IS NOT NULL AND catalog_revision > (SELECT revision FROM user_default_catalog WHERE user_id = ?)").bind(userId, userId),
    env.DB.prepare('UPDATE user_default_catalog SET revision = ? WHERE user_id = ?').bind(target, userId),
  ]);
}
