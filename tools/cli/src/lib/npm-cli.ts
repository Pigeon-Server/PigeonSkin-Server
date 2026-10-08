// npm CLI 查找与调用 —— 从 tools/npm.mjs 移植为 TS（wrangler-target 与 wrangler.ts 共用）。

import { spawnSync, spawn, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';

export function spawnNpmCli(args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) {
  return spawnSync(process.execPath, [findNpmCli(), ...args], options);
}

function npmCliArgs(args: readonly string[]): readonly string[] {
  return [process.execPath, findNpmCli(), ...args];
}

/** spawnNpmCli 的异步版：并发场景（R2 批量上传）用，避免线程池阻塞 */
export function spawnNpmCliAsync(args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCliArgs(args)[0]!, [...npmCliArgs(args).slice(1)], {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => { stdout += d; });
    child.stderr!.on('data', (d) => { stderr += d; });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

function findNpmCli(): string {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const executable = join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!existsSync(executable)) continue;
    const resolved = realpathSync(executable);
    if (resolved.endsWith('.js')) return resolved;
    const candidate = join(dirname(resolved), 'node_modules/npm/bin/npm-cli.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 npm CLI，请先安装 Node.js 与 npm');
}

export { spawnSync };

