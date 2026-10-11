// 仓库路径解析：所有工具脚本统一从这里拿仓库内的绝对路径。
//
// 依据：npm scripts 一律在仓库根执行（npm 会把 cwd 设为 package.json 所在
// 目录），所以 process.cwd() 就是仓库根。脚本永远不依赖"自己被放在哪"，
// 目录再怎么调整也不用改 import 或上溯路径。
import { resolve } from 'node:path';

export const repoRoot = process.cwd();
export const serverDir = resolve(repoRoot, 'apps/server');
export const webDir = resolve(repoRoot, 'apps/web');
export const wranglerConfig = resolve(repoRoot, 'wrangler.jsonc');
