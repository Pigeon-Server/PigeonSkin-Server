import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deploymentConfig } from './release/deployment-config.mjs';
import { spawnNpm } from './npm.mjs';

const [environment, operation] = process.argv.slice(2);
if (!['configure', 'migrate', 'deploy'].includes(operation)) {
  throw new Error('用法：node tools/cloudflare.mjs <preview|production> <configure|migrate|deploy>');
}
const { config, databaseName } = deploymentConfig(environment, process.env);
const apiRoot = fileURLToPath(new URL('../apps/api/', import.meta.url));
// 生成的部署配置统一放仓库根目录：与一键部署脚本同级，一眼可见、便于评审与 CI 引用
const deployConfigPath = fileURLToPath(new URL('../wrangler.deploy.jsonc', import.meta.url));
writeFileSync(deployConfigPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
if (operation !== 'configure') {
  const args = operation === 'migrate'
    ? ['d1', 'migrations', 'apply', databaseName, '--remote']
    : ['deploy'];
  const result = spawnNpm(['exec', '--offline', '--', 'wrangler', ...args, '--env', environment, '--config', deployConfigPath], { cwd: apiRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
