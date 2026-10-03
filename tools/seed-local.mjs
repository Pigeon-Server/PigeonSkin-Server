import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoAccounts, demoSql, validateDemoTargets, validateDemoResult } from './release/demo-data.mjs';
import { spawnNpm } from './npm.mjs';

if (process.argv.length !== 2) throw new Error('本地种子命令不接受远程环境或自定义 Wrangler 参数');
const directory = mkdtempSync(join(tmpdir(), 'pigeon-seed-'));
const apiRoot = fileURLToPath(new URL('../apps/api/', import.meta.url));
function query(sql) {
  const result = spawnNpm(['exec', '--offline', '--', 'wrangler', 'd1', 'execute', 'bs-dev', '--local', '--config', 'wrangler.jsonc', '--command', sql, '--json'], { cwd: apiRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('无法核对本地演示数据库，请先应用迁移');
  return JSON.parse(result.stdout).flatMap(statement => statement.results);
}
try {
  const accounts = await demoAccounts();
  const usersQuery = "SELECT id, email, role, nickname, legacy_email_conflict, password_hash FROM users WHERE lower(email) IN ('admin@example.test', 'user@example.test')";
  const playersQuery = "SELECT name, user_id FROM players WHERE lower(name) IN ('demoadmin', 'demoplayer')";
  validateDemoTargets(accounts, query(usersQuery), query(playersQuery));
  const file = join(directory, 'seed.sql');
  writeFileSync(file, demoSql(accounts), { mode: 0o600 });
  const result = spawnNpm(['exec', '--offline', '--', 'wrangler', 'd1', 'execute', 'bs-dev', '--local', '--config', 'wrangler.jsonc', '--file', file], {
    cwd: apiRoot, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const users = query(usersQuery);
    const players = query(playersQuery);
    validateDemoResult(accounts, users, players);
    for (const account of accounts) console.log(`${account.email} ${account.password}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
