import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnNpm } from '../../../tools/npm.mjs';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const siteRoot = path.resolve(webRoot, '../..');
const upstream = path.join(siteRoot, 'vendor/blockbench');
const destination = path.join(webRoot, 'public/blockbench');
const source = path.join(webRoot, '.cache/blockbench');

function run(command, args, cwd) {
  const result = command === 'npm' ? spawnNpm(args, { cwd, stdio: 'inherit' }) : spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败`);
}

function gitOutput(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} 执行失败`);
  return result.stdout.trim();
}

const gitlink = gitOutput(['ls-files', '--stage', '--', 'vendor/blockbench'], siteRoot).match(/^160000 ([a-f0-9]{40,64}) 0\tvendor\/blockbench$/);
if (!gitlink) throw new Error('缺少 Blockbench 子模块记录，请使用 Git 克隆项目');
const pinnedCommit = gitlink[1];
if (!existsSync(path.join(upstream, 'package.json'))) run('git', ['submodule', 'update', '--init', '--', 'vendor/blockbench'], siteRoot);
if (gitOutput(['rev-parse', 'HEAD'], upstream) !== pinnedCommit) throw new Error('Blockbench 子模块版本与父仓库不一致，请执行 git submodule update --init');
if (gitOutput(['status', '--porcelain', '--untracked-files=no'], upstream)) throw new Error('Blockbench 子模块存在源码修改，请先提交到子模块并更新父仓库引用');

function withSkinOnlyBuild(callback) {
  const bootFile = path.join(source, 'js/boot_loader.js');
  const pluginFile = path.join(source, 'js/plugin_loader.ts');
  const originalBoot = readFileSync(bootFile, 'utf8');
  const originalPlugins = readFileSync(pluginFile, 'utf8');
  const pluginStartup = /Plugins\.loading_promise = new Promise\([\s\S]*?\n\}\)\n\n\$\.getJSON\(/;
  if (!pluginStartup.test(originalPlugins)) throw new Error('Blockbench plugin startup changed; skin editor build was not produced');
  const notice = '// Pigeon Skin Server distribution: installed plugin autoload disabled, 2026-10-03.\n';
  try {
    writeFileSync(bootFile, notice + originalBoot.replace('import { loadInstalledPlugins } from "./plugin_loader";\n', '').replace('loadInstalledPlugins().then(proceed);', 'Promise.resolve().then(proceed);'));
    writeFileSync(pluginFile, notice + originalPlugins.replace(pluginStartup, 'Plugins.loading_promise = Promise.resolve();\n\n$.getJSON('));
    return callback();
  } finally {
    writeFileSync(bootFile, originalBoot);
    writeFileSync(pluginFile, originalPlugins);
  }
}

mkdirSync(path.dirname(source), { recursive: true });
if (!existsSync(path.join(source, '.git'))) {
  run('git', ['clone', '--no-hardlinks', upstream, source], webRoot);
}
if (gitOutput(['status', '--porcelain', '--untracked-files=no'], source)) throw new Error('Blockbench 构建缓存包含源码修改，请使用新的干净缓存');
if (spawnSync('git', ['cat-file', '-e', `${pinnedCommit}^{commit}`], { cwd: source, stdio: 'ignore' }).status !== 0) run('git', ['fetch', '--no-tags', upstream, pinnedCommit], source);
run('git', ['checkout', '--detach', pinnedCommit], source);

const dependencyStamp = path.join(webRoot, '.cache/blockbench-dependencies.sha256');
const dependencyHash = createHash('sha256').update(readFileSync(path.join(source, 'package.json'))).update(readFileSync(path.join(source, 'package-lock.json'))).digest('hex');
if (!existsSync(path.join(source, 'node_modules/esbuild')) || !existsSync(path.join(source, 'node_modules/three')) || !existsSync(dependencyStamp) || readFileSync(dependencyStamp, 'utf8') !== dependencyHash) {
  run('npm', ['ci', '--ignore-scripts', '--workspaces=false'], source);
  writeFileSync(dependencyStamp, dependencyHash);
}
withSkinOnlyBuild(() => {
  run('npm', ['run', 'build-web', '--workspaces=false'], source);

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(path.join(webRoot, 'public/skin-editor.css'), path.join(destination, 'skin-editor.css'));
  for (const entry of ['assets', 'css', 'font', 'dist/bundle.js', 'lib/gif.worker.js', 'LICENSE.MD', 'favicon.png', 'icon_full.png', 'manifest.webmanifest']) {
    const from = path.join(source, entry);
    if (existsSync(from)) cpSync(from, path.join(destination, entry), { recursive: true });
  }

  const htmlPath = path.join(source, 'index.html');
  let html = readFileSync(htmlPath, 'utf8');
  html = html.replace('<head>', '<head>\n\t<base href="/blockbench/">');
  html = html.replace('<link rel="stylesheet" href="css/w3.css">', '<link rel="stylesheet" href="css/w3.css">\n\t<link rel="stylesheet" href="skin-editor.css">');
  html = html.replace('<script type="module" src="dist/bundle.js"></script>', '<script src="/editor-language.js"></script>\n\t<script type="module" src="dist/bundle.js"></script>');
  html = html.replace('</body>', '\t<script type="module" src="/editor-bridge.js"></script>\n</body>');
  writeFileSync(path.join(destination, 'index.html'), html);

  const temporary = mkdtempSync(path.join(tmpdir(), 'pigeon-blockbench-'));
  try {
    const sourceDirectory = path.join(temporary, 'source');
    mkdirSync(sourceDirectory);
    run('git', ['archive', '--format=tar', '--output', path.join(temporary, 'upstream.tar'), pinnedCommit], source);
    run('tar', ['-xf', path.join(temporary, 'upstream.tar'), '-C', sourceDirectory], source);
    for (const entry of ['js/boot_loader.js', 'js/plugin_loader.ts']) cpSync(path.join(source, entry), path.join(sourceDirectory, entry));
    writeFileSync(path.join(sourceDirectory, 'index.html'), html);
    for (const entry of ['skin-editor.css', 'editor-bridge.js', 'editor-language.js']) cpSync(path.join(webRoot, 'public', entry), path.join(sourceDirectory, entry));
    cpSync(fileURLToPath(import.meta.url), path.join(sourceDirectory, 'pigeon-build-blockbench.mjs'));
    cpSync(path.join(siteRoot, 'tools/npm.mjs'), path.join(sourceDirectory, 'pigeon-npm.mjs'));
    writeFileSync(path.join(sourceDirectory, 'SOURCE_NOTICE.txt'), `Blockbench upstream: ${pinnedCommit}\nGPL-3.0-or-later. Copyright JannisX11 and contributors.\nPigeon Skin Server disables installed plugin autoload and adds its skin-editor stylesheet, language adapter and bridge.\nThe complete upstream source, modified files and package-lock.json are included.\nBuild the modified upstream with npm ci --ignore-scripts && npm run build-web.\nPigeon integration recipe: apps/web/scripts/build-blockbench.mjs in https://github.com/Pigeon-Server/PigeonSkin-Server\n`);
    run('tar', ['-czf', path.join(destination, 'source.tar.gz'), '-C', temporary, 'source'], source);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
