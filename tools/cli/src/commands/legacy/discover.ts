// 旧站安装目录自动发现：.env 连接信息、SQL dump、纹理目录。
// 发现顺序：.env 的 DB 配置完整 → mysql 直连（实际可达性由调用方测试）；
// .env 缺失或 DB 不完整但有 *.sql dump → dump 模式。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveExistingDir, resolveExistingFile } from '../../lib/paths.ts';

export interface LegacyEnv {
  readonly dbHost?: string | undefined;
  readonly dbPort?: number | undefined;
  readonly dbDatabase?: string | undefined;
  readonly dbUsername?: string | undefined;
  readonly dbPassword?: string | undefined;
  readonly pwdMethod?: string | undefined;
  readonly salt?: string | undefined;
}

/** 解析旧站 .env。只取 DB_* / PWD_METHOD / SALT；引号与注释按 Laravel .env 惯例处理 */
export function parseLegacyEnvText(text: string): LegacyEnv {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  const port = Number(out['DB_PORT']);
  return {
    dbHost: out['DB_HOST'],
    dbPort: Number.isInteger(port) && port > 0 ? port : undefined,
    dbDatabase: out['DB_DATABASE'],
    dbUsername: out['DB_USERNAME'],
    dbPassword: out['DB_PASSWORD'],
    pwdMethod: out['PWD_METHOD'],
    salt: out['SALT'],
  };
}

export interface DiscoveredSource {
  /** mysql = 直连旧库；dump = 解析 SQL 快照 */
  readonly kind: 'mysql' | 'dump';
  /** 面向报告的描述（不含密码） */
  readonly describe: string;
  readonly env: LegacyEnv;
  /** dump 文件路径（kind=dump 时存在） */
  readonly dumpPath?: string;
}

/** 在旧站目录里发现数据源。不建立连接，只做文件级探测 */
export function discoverSource(dir: string, explicitDump?: string): DiscoveredSource {
  const root = resolveExistingDir(dir, '--dir');
  const envPath = join(root, '.env');
  const env = existsSync(envPath)
    ? parseLegacyEnvText(readFileSync(envPath, 'utf8'))
    : {};

  const dbComplete = Boolean(env.dbHost && env.dbDatabase && env.dbUsername);

  if (explicitDump !== undefined) {
    const dumpPath = resolveExistingFile(explicitDump, '--dump');
    return { kind: 'dump', describe: `SQL dump: ${dumpPath}`, env, dumpPath };
  }

  if (dbComplete) {
    return {
      kind: 'mysql',
      describe: `MySQL ${env.dbUsername}@${env.dbHost}:${env.dbPort ?? 3306}/${env.dbDatabase}`,
      env,
    };
  }

  // 目录里找 *.sql（排除 Laravel 迁移目录内的碎文件）
  const dumps = readdirSync(root)
    .filter((f) => f.toLowerCase().endsWith('.sql') && statSync(join(root, f)).isFile())
    .sort((a, b) => statSync(join(root, b)).size - statSync(join(root, a)).size);
  if (dumps.length > 0) {
    const dumpPath = join(root, dumps[0]!);
    return {
      kind: 'dump',
      describe: `SQL dump: ${dumpPath}${dumps.length > 1 ? `（另有 ${dumps.length - 1} 个候选）` : ''}`,
      env,
      dumpPath,
    };
  }

  throw new Error(
    `目录中既没有可连接的 .env DB 配置，也没有 *.sql dump: ${root}` +
    (existsSync(envPath) ? '（.env 存在但 DB_* 配置不完整）' : '（未找到 .env）'),
  );
}

/** 旧纹理目录：storage/textures（可选，缺失时按纹理行全量写入、不做文件过滤） */
export function discoverTexturesDir(dir: string): string | undefined {
  const textures = join(dir, 'storage', 'textures');
  return existsSync(textures) && statSync(textures).isDirectory() ? textures : undefined;
}
