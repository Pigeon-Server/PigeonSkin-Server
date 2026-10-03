import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicFiles, unsafePath, scanText, symlinkPath } from './public-files.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.argv.slice(2).some(argument => argument !== '--content-only')) throw new Error('仅支持 --content-only 参数');
const files = publicFiles(root);
const findings = [];
for (const path of files) {
  const rule = unsafePath(path);
  if (rule) findings.push({ path, rule });
  if (symlinkPath(root, path)) { findings.push({ path, rule: 'symlink-review' }); continue; }
  const bytes = readFileSync(`${root}/${path}`);
  if (!bytes.subarray(0, 8192).includes(0)) findings.push(...scanText(path, bytes.toString('utf8')));
}
console.log(JSON.stringify({ files: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
