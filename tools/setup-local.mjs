import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const example = readFileSync(new URL('../apps/server/.dev.vars.example', import.meta.url), 'utf8');
const content = example.replace(/^(SESSION_SECRET|SETUP_TOKEN|MFA_ENCRYPTION_KEY)=$/gm, (_, key) => `${key}=${randomBytes(32).toString('base64url')}`);
writeFileSync(new URL('../apps/server/.dev.vars', import.meta.url), content, { mode: 0o600, flag: 'wx' });
console.log('已创建 apps/server/.dev.vars；安装令牌可在该本地文件中查看。');
