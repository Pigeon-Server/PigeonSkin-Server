import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';

export function publicFiles(root) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  const submodules = new Set(execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(record => record.startsWith('160000 ')).map(record => record.slice(record.indexOf('\t') + 1)));
  return [...new Set(output.split('\0').filter(Boolean))].filter(file => !submodules.has(file) && existsSync(`${root}/${file}`)).sort();
}

export function unsafePath(file) {
  const parts = file.split('/');
  const name = parts.at(-1);
  if (/^(?:\.env|\.dev\.vars)(?:\.|$)/.test(name) && !name.endsWith('.example')) return 'environment-file';
  if (parts.some(part => ['old', 'work', '.git', 'node_modules', '.wrangler', '.cache', 'dist', 'coverage', '__pycache__', '.idea', '.vscode', 'uploads', 'backups', 'exports', 'reports', 'test-results', 'playwright-report'].includes(part))) return 'private-or-generated-directory';
  if (/\.(?:pem|key|pfx|p12|crt|cer|db|sqlite3?|log|bak|backup|dump|zip|tar|tgz|pyc|swp|swo)(?:$|[.-])/i.test(name) || /\.tar\.gz$/i.test(name)) return 'private-or-generated-file';
  if (file.startsWith('apps/web/public/blockbench/') || /^docs\/rewrite\/validation-/.test(file)) return 'local-artifact';
  // AGENTS.md 是随库分发的协作约定（保留 secret 扫描等内容规则约束它）
  if (/(?:^|\/)docs\/rewrite\//.test(file) || file.startsWith('tools/cpu-probe/') || file.startsWith('apps/web/public/third-party/')) return 'local-artifact';
  if (parts.includes('.ssh') || /^(?:\.netrc|id_rsa|id_ed25519)$/.test(name) || /\.(?:jks|keystore)$/i.test(name)) return 'private-key-store';
}

const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{100,}-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['provider-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g],
  ['credential-url', /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@'"`]+:[^\s/@'"`]+@[^\s/'"`]+/g],
  ['registry-or-cloud-secret', /\b(?:_authToken|_auth|aws_secret_access_key)[ \t]*[=:][ \t]*["']?[A-Za-z0-9+/=_-]{8,}/gi],
  ['internal-ip', /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
  ['personal-path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//g],
  ['deployment-host', /https:\/\/[\w.-]+\.(?:workers|pages)\.dev\b/g],
  ['cloudflare-id', /["'](?:database_id|account_id)["']\s*:\s*["'][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}["']/gi],
  ['literal-secret', /\b(?:SESSION_SECRET|MFA_ENCRYPTION_KEY|SETUP_TOKEN|JWT_SECRET|SMTP_PASSWORD|CLOUDFLARE_API_TOKEN|RESEND_API_KEY|[A-Z_]+CLIENT_SECRET|LEGACY_SALT)[ \t]*[=:][ \t]*["']?([A-Za-z0-9+/=_-]{8,})/g],
];

export function scanText(file, text) {
  const findings = [];
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (rule === 'literal-secret' && /^(?:undefined|null|process|env|bindings|c\.env)$/.test(match[1])) continue;
      if (rule === 'literal-secret' && file.endsWith('.test.ts') && /^(?:(?:test|legacy|local-test|dev)-[\w-]+|(?:github|little|microsoft)-secret|secret-must-never-be-returned|mail-test)$/.test(match[1])) continue;
      findings.push({ path: file, line: text.slice(0, match.index).split('\n').length, rule });
    }
  }
  return findings;
}

export function symlinkPath(root, file) {
  return lstatSync(`${root}/${file}`).isSymbolicLink();
}
