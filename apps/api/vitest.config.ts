// vitest-pool-workers 配置：在真实的 Workers 运行时（workerd）里跑 API 测试。
//
// 为什么不用 node 环境：API 代码依赖 Workers 专属绑定（D1/R2）与
// Workers 语义的 crypto/caches。@cloudflare/vitest-pool-workers
// 直接在 miniflare 的 workerd 里执行，测试环境与生产一致。
//
// 迁移 SQL 通过虚拟模块注入：workerd 里没有可用的 node:fs，
// 而 vitest.config 在 Node 侧加载，可以在这里读文件再喂给测试代码。
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../packages/db/migrations');

function loadMigrations(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).join('\n');
}

/** 虚拟模块：默认导出迁移脚本全文 */
const MIGRATIONS_MODULE_ID = 'virtual:db-migrations';

export default defineWorkersConfig({
  plugins: [
    {
      name: 'virtual-db-migrations',
      resolveId(id) {
        return id === MIGRATIONS_MODULE_ID ? '\0' + MIGRATIONS_MODULE_ID : null;
      },
      load(id) {
        if (id === '\0' + MIGRATIONS_MODULE_ID) {
          // JSON 编码进模板字符串，避免转义陷阱
          const migrations = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort().map(name => ({ name, sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
          return `export const migrationsSql = ${JSON.stringify(loadMigrations())}; export const migrations = ${JSON.stringify(migrations)};`;
        }
        return null;
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        miniflare: { bindings: { APP_URL: 'http://localhost:8787', OFFICIAL_CATALOG_ENABLED: 'false', RATE_LIMIT_ENABLED: 'false' } },
        wrangler: { configPath: path.resolve(__dirname, 'wrangler.jsonc') },
      },
    },
  },
});
