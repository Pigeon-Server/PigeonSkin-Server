import { defineConfig } from 'vitest/config';

// 纯 Node 侧单元测试。与 tools/migrate 相同：
// 显式禁用 PostCSS，避免 Vite 从 root 向上查找命中根目录的 postcss.config.js。
export default defineConfig({
  css: {
    postcss: { plugins: [] },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      deps: {
        external: [/^node:/],
      },
    },
  },
});
