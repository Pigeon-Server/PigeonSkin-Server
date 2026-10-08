// Node 部署构建脚本：把 API 打包为单文件 bundle（node dist-node/entry.mjs）。
//
// node:sqlite 是内置模块必须 external；ioredis 懒加载（REDIS_URL 配置才
// import），标 external 让 bundle 只留 import 语句，运行时 node_modules
// 里有即可——未用 Redis 的部署产物不含这个依赖；其余业务依赖全部内联
// （Hono/jose/zod/marked/fflate/linkedom/postgres/mysql2/aws4fetch/@hono/node-server）。
// 注意 packages/* 源码以 .ts 后缀互引（allowImportingTsExtensions），
// esbuild 原生支持解析。
//
// 用法：node scripts/build-node.mjs（在 apps/api 下执行）

import { build } from 'esbuild';

await build({
  entryPoints: ['src/entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist-node/entry.mjs',
  sourcemap: true,
  external: ['node:*', 'cloudflare:*', 'ioredis'],
  // CJS 依赖（mysql2 等）内联后 require('buffer') 等 Node 内置调用需要
  // shim：format esm 下 esbuild 不自动注入 createRequire
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = (() => { try { return require('path').dirname(__filename); } catch { return '.'; } })();",
    ].join('\n'),
  },
  // pg-native 是 postgres.js 的可选原生绑定，打包器会试图解析它
  alias: { 'pg-native': './empty-pg-native.js' },
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
}).then(result => {
  const output = Object.values(result.metafile.outputs).find(o => o.entryPoint)?.bytes ?? 0;
  console.log(`bundle: dist-node/entry.mjs (${Math.round(output / 1024)} KiB)`);
});
