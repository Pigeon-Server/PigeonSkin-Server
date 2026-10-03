// derivatives:backfill —— 为旧站纹理目录生成衍生图（头像 2d/3d + 全身预览）。
//
// 2026-09-30 起，线上生成由 Worker 的 DerivativeGenerator DO 按需完成；
// 本命令的角色收窄为**迁移前的批量离线预生成**（Node + sharp，无 CPU 限制，
// 适合在导入几万张旧纹理时一次性把产物准备好，避免上线初期集中触发 DO）。
//
// 设计依据 docs/rewrite/06-texture-architecture.md §6.2（+2026-09-30 修订）：
//   • 产物是普通 PNG 文件，键与线上 R2 布局一致：
//       avatars/v3/{hash}/2d-{size}.png  avatars/v3/{hash}/3d/{size}.png  previews/v3/{hash}.png
//     上传仍由运维用 wrangler r2 object put 执行（CLI 不持 CF 凭据）；
//   • 幂等：产物已存在且非空时跳过，可反复运行。
//   • 源文件按旧站约定"文件名即内容哈希"（storage/textures 扁平目录）。
//
// 用法:
//   node src/index.ts backfill --textures ./storage/textures [--out ./derivatives] \
//     [--sizes 100,64]

import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { renderAvatar2d, renderAvatar3d, renderPreview, avatarObjectKey, previewObjectKey } from '@pigeon-skin/minecraft';

// 与 packages/shared LIMITS.derivativeSizes 保持一致的白名单
// （@pigeon-skin/minecraft 提供渲染器；尺寸白名单常量在此处本地重复一份，
// 避免 migrate 包对 shared 包产生传递依赖）
const DERIVATIVE_SIZES: readonly number[] = [36, 45, 64, 100, 200];

function isAllowedDerivativeSize(size: number): boolean {
  return DERIVATIVE_SIZES.includes(size);
}

/** 用 sharp 解码 PNG 为 RGBA 像素（供共享渲染器消费） */
async function decodeToRgba(png: Buffer): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: new Uint8Array(data) };
}

export interface BackfillOptions {
  readonly texturesDir: string;
  /** 输出根目录；默认 texturesDir 同级的 ./derivatives */
  readonly outDir?: string | undefined;
  /** 头像尺寸白名单子集，默认 100 与 64 */
  readonly sizes?: readonly number[] | undefined;
  readonly metadataDbPath?: string | undefined;
  onProgress?: ((msg: string) => void) | undefined;
}

export interface BackfillResult {
  readonly avatar2d: number;
  readonly avatar3d: number;
  readonly preview: number;
  readonly skipped: number;
  readonly failed: readonly { hash: string; reason: string }[];
}

export async function backfill(opts: BackfillOptions): Promise<BackfillResult> {
  const log = opts.onProgress ?? (() => {});
  const dir = resolve(opts.texturesDir);
  const out = resolve(opts.outDir ?? join(dir, '..', 'derivatives'));
  const sizes = (opts.sizes ?? [100, 64]).filter(isAllowedDerivativeSize);
  const metadata = new Map<string, { kind: string; model: string | null }>();
  if (opts.metadataDbPath) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const database = new DatabaseSync(resolve(opts.metadataDbPath), { readOnly: true });
    for (const row of database.prepare("SELECT hash,kind,model FROM textures ORDER BY kind = 'skin' DESC").all()) {
      if (!metadata.has(String(row.hash))) metadata.set(String(row.hash), { kind: String(row.kind), model: row.model === null ? null : String(row.model) });
    }
    database.close();
  }
  if (sizes.length === 0) throw new Error('没有合法的 --sizes（白名单 36/45/64/100/200）');

  mkdirSync(out, { recursive: true });
  const result = { avatar2d: 0, avatar3d: 0, preview: 0, skipped: 0, failed: [] as { hash: string; reason: string }[] };

  const hashes = [];
  for (const name of await import('node:fs').then((fs) => fs.readdirSync(dir))) {
    if (!/^[a-f0-9]{64}$/.test(name) || (opts.metadataDbPath && !metadata.has(name))) continue;
    if (statSync(join(dir, name)).isFile()) hashes.push(name);
  }

  for (const hash of hashes) {
    try {
      const png = readFileSync(join(dir, hash));
      const img = await decodeToRgba(png);

      const meta = metadata.get(hash);
      const isCape = meta?.kind === 'cape';

      // 幂等：检查每个产物是否存在
      const jobs: Array<{ file: string; produce: () => Promise<Buffer> }> = [];
      for (const size of isCape ? [] : sizes) {
        jobs.push({
          file: join(out, avatarObjectKey(hash, '2d', size)),
          produce: async () => {
            const out2 = renderAvatar2d(img, size);
            return await encodeRawToPng(out2);
          },
        });
        jobs.push({
          file: join(out, avatarObjectKey(hash, '3d', size)),
          produce: async () => {
            const out2 = renderAvatar3d(img, size);
            return await encodeRawToPng(out2);
          },
        });
      }
      // 宽度与 Worker DO 侧产物（128px）保持一致：同一 R2 键两种内容
      // 时先到者得，尺寸一致就无所谓谁先
      jobs.push({
        file: join(out, previewObjectKey(hash)),
        produce: async () => {
          const scaled = renderPreview(img, isCape ? 125 : 128, isCape, meta?.model === 'slim');
          return await encodeRawToPng(scaled);
        },
      });

      for (const job of jobs) {
        if (existsSync(job.file) && statSync(job.file).size > 0) {
          result.skipped++;
          continue;
        }
        const bytes = await job.produce();
        mkdirSync(join(job.file, '..'), { recursive: true });
        writeFileSync(job.file, bytes);
      }
      result.avatar2d += isCape ? 0 : sizes.length;
      result.avatar3d += isCape ? 0 : sizes.length;
      result.preview += 1;
    } catch (e) {
      result.failed.push({ hash, reason: String(e).slice(0, 120) });
    }
  }

  log(`backfill 完成: ${hashes.length} 个源文件, ` +
    `${result.failed.length} 失败, 产物在 ${out}`);
  log('上传: wrangler r2 object put --pipe < avatars/…/2d-100.png');
  return result;
}


// ── 本地 PNG/缩放工具（与 packages/minecraft codec 同语义；CLI 侧用 sharp 编码）──

/** RGBA 原始像素 → PNG（sharp 打包；与 codec.ts 的 encodePng 同为合法 PNG） */
async function encodeRawToPng(
  img: { width: number; height: number; rgba: Uint8Array },
): Promise<Buffer> {
  return await sharp(Buffer.from(img.rgba), {
    raw: { width: img.width, height: img.height, channels: 4 },
  }).png().toBuffer();
}
