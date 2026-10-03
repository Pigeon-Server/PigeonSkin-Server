import { randomBytes } from 'node:crypto';
import { hashPassword } from '../../packages/auth/src/password.ts';

export async function demoAccounts() {
  return Promise.all([
    { email: 'admin@example.test', nickname: 'Demo Admin', role: 'super_admin', score: 10000, player: 'DemoAdmin' },
    { email: 'user@example.test', nickname: 'Demo User', role: 'normal', score: 1000, player: 'DemoPlayer' },
  ].map(async account => {
    const password = randomBytes(24).toString('base64url');
    return { ...account, password, hash: await hashPassword(password) };
  }));
}

export function demoSql(accounts) {
  return accounts.map(account => `INSERT INTO users (email, email_verified_at, nickname, score, password_hash, role, created_at, updated_at)
SELECT '${account.email}', strftime('%s','now') * 1000, '${account.nickname}', ${account.score}, '${account.hash}', '${account.role}', strftime('%s','now') * 1000, strftime('%s','now') * 1000
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = '${account.email}' COLLATE NOCASE);
UPDATE users SET password_hash = '${account.hash}', updated_at = strftime('%s','now') * 1000 WHERE email = '${account.email}' COLLATE NOCASE AND legacy_email_conflict = 0;
INSERT OR IGNORE INTO players (user_id, name, created_at, updated_at)
SELECT id, '${account.player}', strftime('%s','now') * 1000, strftime('%s','now') * 1000 FROM users WHERE email = '${account.email}' COLLATE NOCASE AND legacy_email_conflict = 0;`).join('\n');
}

export function validateDemoTargets(accounts, users, players) {
  for (const account of accounts) {
    const matches = users.filter(user => user.email.toLowerCase() === account.email);
    const user = matches[0];
    if (matches.length > 1 || (user && (user.legacy_email_conflict !== 0 || user.role !== account.role || user.nickname !== account.nickname))) throw new Error('演示邮箱已被非演示账号占用，未重置密码');
    const player = players.find(player => player.name.toLowerCase() === account.player.toLowerCase());
    if (player && (!user || player.user_id !== user.id)) throw new Error('演示角色名已被其他账号占用');
  }
}

export function validateDemoResult(accounts, users, players) {
  validateDemoTargets(accounts, users, players);
  for (const account of accounts) {
    const user = users.find(user => user.email.toLowerCase() === account.email);
    if (!user || user.password_hash !== account.hash || !players.some(player => player.name.toLowerCase() === account.player.toLowerCase() && player.user_id === user.id)) throw new Error('本地演示数据写入核对失败，未输出密码');
  }
}
