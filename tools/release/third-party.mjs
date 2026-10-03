import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const destination = path.join(root, 'apps/web/public/third-party');
const lockfile = readFileSync(path.join(root, 'package-lock.json'));
const lock = JSON.parse(lockfile.toString('utf8'));
const packages = new Map();
for (const [location, record] of Object.entries(lock.packages)) {
  if (record.link || !location.split('/').includes('node_modules')) continue;
  const directory = path.join(root, location);
  const manifestPath = path.join(directory, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const declaredLicense = manifest.license ?? record.license;
  const license = typeof declaredLicense === 'string' ? declaredLicense : declaredLicense?.type || 'UNKNOWN';
  const key = `${manifest.name}@${manifest.version}:${license}`;
  if (!packages.has(key)) packages.set(key, { name: manifest.name, versions: [manifest.version], license, paths: [] });
  packages.get(key).paths.push(directory);
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
const inventory = [];
for (const entry of packages.values()) {
  const license = entry.license;
  const notices = [];
  for (const directory of entry.paths) {
    const files = readdirSync(directory, { withFileTypes: true }).filter(file => file.isFile() && /^(?:licen[sc]e|notice|copying|copyright)(?:[._-]|$)/i.test(file.name));
    for (const file of files) {
      const content = readFileSync(path.join(directory, file.name), 'utf8');
      if (!notices.includes(content)) notices.push(content);
    }
  }
  const name = `${entry.name}-${entry.versions[0]}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (notices.length) writeFileSync(path.join(destination, `${name}.txt`), `${entry.name} (${entry.versions.join(', ')})\n${license}\n\n${notices.join('\n\n')}`);
  inventory.push({ name: entry.name, versions: entry.versions, license, notice: notices.length ? `${name}.txt` : null });
}
inventory.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(path.join(destination, 'index.json'), JSON.stringify({ lockfileSha256: createHash('sha256').update(lockfile).digest('hex'), packages: inventory }, null, 2) + '\n');
const missing = inventory.filter(entry => entry.notice === null);
if (missing.length) console.warn(`以下依赖缺少根目录 LICENSE/NOTICE，发行物仍需核对：${missing.map(entry => entry.name).join(', ')}`);
console.log(`已收集 ${inventory.length - missing.length} 个依赖的原始许可声明。`);
