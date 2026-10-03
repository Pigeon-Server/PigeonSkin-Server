import { defineConfig } from 'vitest/config';

// 纯 Node 单元测试。禁用 PostCSS 的原因同其它包：根目录遗留的旧前端配置
// 会被 Vite 向上查找到。
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
