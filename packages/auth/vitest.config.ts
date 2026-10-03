import { defineConfig } from 'vitest/config';

// 纯 Node 单元测试，不涉及 CSS。必须显式禁用 PostCSS：
// 否则 Vite 会向上查找配置，命中仓库根目录遗留的 postcss.config.js
// （它引用了本包没装的 autoprefixer）而报错。
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
