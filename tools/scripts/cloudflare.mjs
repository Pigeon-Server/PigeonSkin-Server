import { writeFileSync } from 'node:fs';
import { deploymentConfig } from './deployment-config.mjs';
import { spawnNpm } from './npm.mjs';
import { resolve } from 'node:path';
import { repoRoot, serverDir, webDir } from './paths.mjs';

const [environment, operation] = process.argv.slice(2);
if (!['configure', 'migrate', 'deploy'].includes(operation)) {
  throw new Error('用法：node tools/scripts/cloudflare.mjs <preview|production> <configure|migrate|deploy>');
}
const { config, databaseName } = deploymentConfig(environment, process.env);
const apiRoot = serverDir;
// 生成的部署配置是独立产物（gitignore）：绝不能写回 wrangler.jsonc 源文件
const deployConfigPath = resolve(repoRoot, 'wrangler.deploy.jsonc');
writeFileSync(deployConfigPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
if (operation !== 'configure') {
  const args = operation === 'migrate'
    ? ['d1', 'migrations', 'apply', databaseName, '--remote']
    : ['deploy'];
  const result = spawnNpm(['exec', '--offline', '--', 'wrangler', ...args, '--env', environment, '--config', deployConfigPath], { cwd: apiRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
