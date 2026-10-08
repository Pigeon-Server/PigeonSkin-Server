// Node 冒烟测试配置：跑在普通 Node 环境（非 workerd）。
//
// 覆盖 Node 侧适配器（D1 形状适配器、存储、队列、缓存、迁移），
// 与 vitest.config.ts（workerd 池，Worker 路径回归）互不干扰。
// test/node/ 目录之外的测试仍走 workerd 池。

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'node',
    include: ['test/node/**/*.test.ts'],
    testTimeout: 30_000,
    environment: 'node',
    pool: 'forks',
    // node:sqlite 等 Node 内置模块交给 Node 自身解析（vite-node 的
    // 内置模块识别只覆盖无子路径的经典名称）
    deps: { external: [/^node:/] },
    server: { deps: { external: [/^node:/] } },
  },
});
