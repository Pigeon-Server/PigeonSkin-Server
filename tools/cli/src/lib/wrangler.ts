// wrangler 调用封装 —— 全部 D1/R2 读写经由 spawn npm exec wrangler 完成，
// CLI 自身不持 CF 凭据（与 seed-local.mjs、docs/rewrite/09 的既定原则一致）。
//
//   D1 读：wrangler d1 execute <db> <scope> --config wrangler.jsonc --json --command "..."
//   D1 写：临时 SQL 文件 + --file（绕开 shell 参数长度与引号限制）
//   R2：  wrangler r2 object put/get <bucket>/<key> <scope>

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TargetEnv } from './env.ts';
import { apiWorkingDir } from './env.ts';
import { spawnNpmCli } from './npm-cli.ts';

export interface D1Row {
  readonly [column: string]: null | number | string;
}

function spawnNpm(args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) {
  return spawnNpmCli(args, options);
}

const MAX_BUFFER = 512 * 1024 * 1024;

// wrangler 的 --local/--remote 必须出现在子命令之后
// （`wrangler --local d1 execute` 会报 Unknown arguments），故由各函数自行插入
function wranglerArgs(env: TargetEnv, ...sub: readonly string[]): string[] {
  const args = ['exec', '--offline', '--', 'wrangler', ...sub, env.scopeFlag];
  return env.persistTo ? [...args, '--persist-to', env.persistTo] : args;
}

/** 抛出带 wrangler stderr 的一致错误 */
function failWrangler(what: string, result: ReturnType<typeof spawnSync>): never {
  const err = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  const out = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  throw new Error(`${what} 失败（exit ${result.status ?? '?'}）:\n${err || out || '无输出'}`);
}

/** 执行一条查询，返回结果行（d1 execute --json 输出为 [{results: [...]}]） */
export function d1Query(env: TargetEnv, sql: string): D1Row[] {
  const result = spawnNpm(
    [...wranglerArgs(env, 'd1', 'execute', env.d1Database),
      '--config', 'wrangler.jsonc', '--json', '--command', sql],
    { cwd: apiWorkingDir(), encoding: 'utf8', maxBuffer: MAX_BUFFER },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) failWrangler(`D1 查询失败: ${sql.slice(0, 120)}`, result);
  try {
    const parsed = JSON.parse(result.stdout) as { results?: D1Row[] }[];
    return parsed.flatMap((s) => s.results ?? []);
  } catch {
    throw new Error(`D1 查询输出无法解析为 JSON: ${result.stdout.slice(0, 200)}`);
  }
}

export interface ExecResult {
  readonly changes: number;
}

/** 执行一批 SQL 语句（写入临时文件走 --file）；返回受影响行数合计 */
export function d1ExecuteFile(env: TargetEnv, statements: readonly string[]): ExecResult {
  if (statements.length === 0) return { changes: 0 };
  const dir = mkdtempSync(join(tmpdir(), 'pigeon-cli-'));
  const file = join(dir, 'batch.sql');
  try {
    writeFileSync(file, statements.join(';\n') + ';\n', { mode: 0o600 });
    const result = spawnNpm(
      [...wranglerArgs(env, 'd1', 'execute', env.d1Database),
        '--config', 'wrangler.jsonc', '--json', '--file', file],
      { cwd: apiWorkingDir(), encoding: 'utf8', maxBuffer: MAX_BUFFER },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) failWrangler('D1 写入失败', result);
    let changes = 0;
    try {
      const parsed = JSON.parse(result.stdout) as { meta?: { changes?: number } }[];
      for (const s of parsed) changes += s.meta?.changes ?? 0;
    } catch {
      // --json 解析失败不算致命：写入本身已成功
    }
    return { changes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 上传一个对象；幂等（同键覆盖）。scope 与 D1 一致，由 env 决定 */
export function r2Put(env: TargetEnv, key: string, filePath: string): void {
  const result = spawnNpm(
    [...wranglerArgs(env, 'r2', 'object', 'put', `${env.r2Bucket}/${key}`),
      '--config', 'wrangler.jsonc', '--file', filePath],
    { cwd: apiWorkingDir(), encoding: 'utf8', maxBuffer: MAX_BUFFER },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) failWrangler(`R2 上传失败: ${key}`, result);
}

/** r2Put 的异步并发版：用异步 spawn，支持多路并发（wrangler 单次调用含冷启动，串行太慢）。
 * 偶发的 workerd 僵死用一次重试兜底。 */
export async function r2PutAsync(env: TargetEnv, key: string, filePath: string): Promise<void> {
  const { spawnNpmCliAsync } = await import('./npm-cli.ts');
  const attempt = async (): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    spawnNpmCliAsync(
      ['exec', '--offline', '--', 'wrangler', 'r2', 'object', 'put', `${env.r2Bucket}/${key}`,
        env.scopeFlag, '--config', 'wrangler.jsonc', '--file', filePath,
        ...(env.persistTo ? ['--persist-to', env.persistTo] : [])],
      { cwd: apiWorkingDir(), encoding: 'utf8', maxBuffer: MAX_BUFFER },
    );
  let last = await attempt();
  if (last.status !== 0) last = await attempt();
  if (last.status !== 0) {
    throw new Error(`R2 上传失败: ${key}（exit ${last.status ?? '?'}）\n${(last.stderr || last.stdout).slice(0, 500)}`);
  }
}

/** 下载一个对象到本地文件；对象不存在时返回 false */
export function r2Get(env: TargetEnv, key: string, destPath: string): boolean {
  const result = spawnNpm(
    [...wranglerArgs(env, 'r2', 'object', 'get', `${env.r2Bucket}/${key}`),
      '--config', 'wrangler.jsonc', '--file', destPath],
    { cwd: apiWorkingDir(), encoding: 'utf8', maxBuffer: MAX_BUFFER },
  );
  if (result.status === 0) return true;
  const combined = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  if (/not found|not exist|10002|no bucket/i.test(combined)) return false;
  failWrangler(`R2 下载失败: ${key}`, result);
}

/** 读取一个文件（仅在需要按字节处理时使用） */
export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
