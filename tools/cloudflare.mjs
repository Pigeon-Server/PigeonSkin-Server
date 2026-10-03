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
writeFileSync(new URL('../apps/api/wrangler.deploy.jsonc', import.meta.url), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
if (operation !== 'configure') {
  const args = operation === 'migrate'
    ? ['d1', 'migrations', 'apply', databaseName, '--remote']
    : ['deploy'];
  const result = spawnNpm(['exec', '--offline', '--', 'wrangler', ...args, '--env', environment, '--config', 'wrangler.deploy.jsonc'], { cwd: apiRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
