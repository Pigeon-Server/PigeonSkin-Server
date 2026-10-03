// 纹理文件侧的迁移：扫描旧 storage/textures、校验哈希、产出 R2 对象清单。
//
// 单独成文件，与 SQL 层彻底分离：这里只处理文件系统。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function fileSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 扫描旧纹理目录（扁平、无扩展名、文件名即哈希）；目录不可用返回 null */
export function scanTextureDir(texturesDir: string | undefined): Set<string> | null {
  if (!texturesDir) return null;
  const dir = resolve(texturesDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const out = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    try {
      if (statSync(resolve(dir, name)).isFile()) out.add(name);
    } catch { /* 读不到的条目跳过 */ }
  }
  return out;
}

export interface R2ObjectPlan {
  /** R2 键 → 本地源文件绝对路径。键形如 textures/<hash>.png */
  readonly objects: ReadonlyMap<string, string>;
  /** 旧库声明、磁盘缺失的哈希（这些纹理导入后请求会 503） */
  readonly missing: readonly string[];
}

/**
 * 依据旧库的 distinct hash 与磁盘实际文件，产出 R2 上传清单。
 * 已上传过的哈希（uploadedHashes，来自上次运行的 checkpoint）会被跳过。
 */
export function planR2Objects(
  texturesDir: string,
  distinctHashes: readonly string[],
  uploadedHashes: ReadonlySet<string>,
): R2ObjectPlan {
  const onDisk = scanTextureDir(texturesDir);
  const objects = new Map<string, string>();
  const missing: string[] = [];

  for (const hash of distinctHashes) {
    if (uploadedHashes.has(hash)) continue;
    if (onDisk?.has(hash)) {
      objects.set(`textures/${hash}.png`, resolve(texturesDir, hash));
    } else {
      missing.push(hash);
    }
  }
  return { objects, missing };
}

/** 复核一个文件的内容哈希是否等于其文件名（旧库的内容寻址不变量） */
export function verifyContentHash(filePath: string): boolean {
  const name = filePath.split('/').pop() ?? '';
  try {
    return fileSha256(readFileSync(filePath)) === name;
  } catch {
    return false;
  }
}
