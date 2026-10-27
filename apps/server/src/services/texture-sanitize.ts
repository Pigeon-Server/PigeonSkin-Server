// 存量材质净化的一批处理逻辑。
//
// 抽成独立函数而不是留在 Durable Object 里，有两个原因：
//   1. 可以直接测试（DO 的 storage/R2 在 workerd 测试里有隔离存储的坑）；
//   2. DO 只承担「调度与游标持久化」，批处理本身是纯业务。
//
// 一批的处理顺序固定：读旧字节 → 解码重编码 → 写新对象 → 改行 hash →
// 清旧对象（仅当无其它行引用）→ 派生图失效。任何一步失败都只影响本行，
// 游标已经前进，不会让整条队列卡死。
import { type Bindings } from './../core/env.ts';
import { isD1QuotaError } from '../core/usage-budget.ts';
import { HARD_TEXTURE_MAX_BYTES, sanitizeTexture, sha256Hex } from '@pigeon-skin/minecraft';
import { createDb, textures, siteStats } from '@pigeon-skin/db';
import { and, eq, sql, inArray } from 'drizzle-orm';

export interface SanitizeJobState {
  cursor: number;
  processed: number;
  changed: number;
  skipped: number;
  failed: number;
  retries: number;
  done: boolean;
}

export const SANITIZE_BATCH_SIZE = 8;

export function newSanitizeJob(): SanitizeJobState {
  return { cursor: 0, processed: 0, changed: 0, skipped: 0, failed: 0, retries: 0, done: false };
}

/** 处理一批未净化材质。就地更新 job，返回 true 表示队列已清空。 */
export async function sanitizeBatch(env: Bindings, job: SanitizeJobState): Promise<boolean> {
  const db = createDb(env.DB);
  const rows = await db
    .select({ id: textures.id, hash: textures.hash })
    .from(textures)
    .where(and(eq(textures.sanitized, 0), sql`${textures.id} > ${job.cursor}`))
    .orderBy(textures.id)
    .limit(SANITIZE_BATCH_SIZE);

  if (!rows.length) { job.done = true; return true; }

  for (const row of rows) {
    job.cursor = row.id;
    job.processed++;
    try {
      const object = await env.BUCKET.get(`textures/${row.hash}.png`);
      if (!object) { job.skipped++; await markSanitized(env, row.id); continue; }
      const bytes = new Uint8Array(await object.arrayBuffer()) as Uint8Array<ArrayBuffer>;
      if (bytes.length > HARD_TEXTURE_MAX_BYTES) {
        // 存量高清对象仍可读取，但不让超大压缩 PNG 进入净化解码路径。
        job.skipped++;
        await markSanitized(env, row.id);
        continue;
      }
      const result = await sanitizeTexture(bytes);
      if (!result.ok) {
        // 结构上无法重编码（历史脏数据）：标记跳过，否则每轮都重试同一张
        job.skipped++;
        await markSanitized(env, row.id);
        continue;
      }
      const newHash = await sha256Hex(result.bytes);
      if (newHash === row.hash) {
        // 字节本来就干净：只改标记与实测尺寸
        await markSanitized(env, row.id, result.width, result.height, result.bytes.length);
        continue;
      }
      // hash 变了的行,协议出口（/{name}.json、/skin/{name}.png）内容随之变、
      // URL 不变。必须在改写前推进穿戴者的 players.updated_at:ETag 取自它,
      // 不推进则客户端带旧 ETag 重验证永远 304,继续请求马上要被删掉的旧 hash。
      const access = await import('./texture-access.ts');
      const wearing = await access.playersWearingTexture(env, row.id, Date.now());
      await env.BUCKET.put(`textures/${newHash}.png`, result.bytes, {
        httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
      });
      await db.update(textures)
        .set({ hash: newHash, width: result.width, height: result.height, sizeBytes: result.bytes.length, sanitized: 1 })
        .where(eq(textures.id, row.id));
      job.changed++;
      // hash 不唯一：旧对象仍被其它行共用时不能删
      const stillReferenced = await db.select({ id: textures.id }).from(textures)
        .where(eq(textures.hash, row.hash)).limit(1);
      if (!stillReferenced.length) await env.BUCKET.delete(`textures/${row.hash}.png`);
      // 派生图按 hash 寻址，hash 变了旧产物必须失效（否则预览一直用旧图）
      await access.purgeTextureDerivatives(env, row.hash);
      await access.purgeTextureDerivatives(env, newHash);
      for (const name of wearing) await access.purgePlayerProfiles(env, name);
    } catch (error) {
      if (isD1QuotaError(error)) throw error;
      job.failed++;
      console.error(`材质 ${row.id} 净化失败:`, error instanceof Error ? error.message : String(error));
    }
  }
  return false;
}

async function markSanitized(env: Bindings, id: number, width?: number, height?: number, sizeBytes?: number) {
  await createDb(env.DB).update(textures)
    .set({ sanitized: 1, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(sizeBytes !== undefined ? { sizeBytes } : {}) })
    .where(eq(textures.id, id));
}

// ── 进度查询与作业启动 ────────────────────────────────────────────────────────

export interface TextureSanitizeStatus {
  /** 尚未净化的材质行数（textures.sanitized = 0） */
  pending: number;
  total: number;
  job: SanitizeJobState | null;
}

export async function textureSanitizeStatus(env: Bindings): Promise<TextureSanitizeStatus> {
  const counts = Object.fromEntries((await createDb(env.DB).select().from(siteStats).where(inArray(siteStats.metric, ['textures', 'unsanitized_textures']))).map(row => [row.metric, Number(row.value)]));
  const sanitizer = env.TEXTURE_SANITIZER.get(env.TEXTURE_SANITIZER.idFromName('textures'));
  const response = await sanitizer.fetch('https://texture-sanitizer/progress', { method: 'POST' });
  const job = response.ok ? await response.json<SanitizeJobState | null>() : null;
  return { total: counts.textures ?? 0, pending: counts.unsanitized_textures ?? 0, job };
}

/** 入队（或续跑）净化作业。已在运行时 DO 返回当前进度，不会重复开批。 */
export async function startTextureSanitize(env: Bindings): Promise<{ cursor: number; started: boolean }> {
  const sanitizer = env.TEXTURE_SANITIZER.get(env.TEXTURE_SANITIZER.idFromName('textures'));
  const response = await sanitizer.fetch('https://texture-sanitizer/start', { method: 'POST' });
  if (!response.ok) throw new Error('Texture sanitizer unavailable');
  const job = await response.json<SanitizeJobState>();
  return { cursor: job.cursor, started: true };
}
