// 环境解析：--env local（默认）/ --env production。
// 与 seed-local.mjs 一致，wrangler 以 apps/api 为 cwd、--config wrangler.jsonc 运行，
// 数据库/bucket 名与 wrangler.jsonc 中的 d1_databases / r2_buckets 对应：
//   local  → bs-dev / bs-dev-textures（--local）
//   remote → bs-prod / bs-prod-textures（--remote）
// CLI 不持 CF 凭据；生产凭据交给已登录的 wrangler（docs/rewrite/09 既定原则）。

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface TargetEnv {
  readonly name: 'local' | 'production';
  readonly d1Database: string;
  readonly r2Bucket: string;
  /** wrangler 的 --local / --remote 标志 */
  readonly scopeFlag: '--local' | '--remote';
  /** 面向用户的显示名 */
  readonly label: string;
  /** --persist-to：本地隔离持久化目录（测试/演练用）；未设置为 wrangler 默认 */
  readonly persistTo?: string | undefined;
}

const LOCAL: TargetEnv = {
  name: 'local',
  d1Database: 'bs-dev',
  r2Bucket: 'bs-dev-textures',
  scopeFlag: '--local',
  label: '本地开发库（bs-dev）',
};

const PRODUCTION: TargetEnv = {
  name: 'production',
  d1Database: 'bs-prod',
  r2Bucket: 'bs-prod-textures',
  scopeFlag: '--remote',
  label: '生产库（bs-prod）',
};

export function resolveEnv(flags: ReadonlyMap<string, string | true>): TargetEnv {
  const v = flags.get('env');
  const base = v === 'production' ? PRODUCTION : LOCAL;
  if (v !== undefined && v !== 'local' && v !== 'production') {
    throw new Error(`--env 只支持 local / production（收到 ${v}）`);
  }
  const persistTo = flags.get('persist-to');
  if (typeof persistTo === 'string' && persistTo !== '') {
    return { ...base, persistTo };
  }
  return base;
}

/** wrangler 的运行目录：仓库内 apps/api（wrangler.jsonc 所在处） */
export function apiWorkingDir(): string {
  // 本文件位于 tools/cli/src/lib/，上溯四级到仓库根
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  return join(root, 'apps', 'api');
}
