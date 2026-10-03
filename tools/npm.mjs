import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function spawnNpm(args, options) {
  let cli = process.env.npm_execpath;
  if (!cli || !existsSync(cli)) {
    cli = undefined;
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      const executable = path.join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'npm.cmd' : 'npm');
      if (!existsSync(executable)) continue;
      const resolved = realpathSync(executable);
      if (resolved.endsWith('.js')) { cli = resolved; break; }
      const candidate = path.join(path.dirname(resolved), 'node_modules/npm/bin/npm-cli.js');
      if (existsSync(candidate)) { cli = candidate; break; }
    }
  }
  if (!cli) throw new Error('找不到 npm CLI，请先安装 Node.js 与 npm');
  return spawnSync(process.execPath, [cli, ...args], options);
}
