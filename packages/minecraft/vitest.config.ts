import { defineConfig } from 'vitest/config';

// 纯 Node 单元测试。禁用 PostCSS 的原因同 packages/auth：
// 仓库根目录还遗留旧前端的 postcss.config.js，会被 Vite 向上查找到。
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
