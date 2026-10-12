// 仓库路径解析：所有工具脚本统一从这里拿仓库内的绝对路径。
//
// 根定位优先 process.cwd()（根 npm scripts 执行时 cwd 即仓库根），但
// workspace 包脚本的 cwd 是各自目录（如 web 的 prebuild），此时回落到
// 本文件位置推导——paths.mjs 固定在 <root>/tools/scripts/，上溯两级即根。
// 判据不是"有没有 package.json"（workspace 目录也有），而是"有没有
// workspaces 声明"，这是 monorepo 根独有的标记。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function isWorkspaceRoot(dir) {
  if (!existsSync(resolve(dir, 'package.json'))) return false;
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    return Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0;
  } catch {
    return false;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const rootFromHere = resolve(here, '../..');
const repoRoot = isWorkspaceRoot(process.cwd()) ? process.cwd() : rootFromHere;

export { repoRoot };
export const serverDir = resolve(repoRoot, 'apps/server');
