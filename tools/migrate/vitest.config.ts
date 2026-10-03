import { defineConfig } from 'vitest/config';

// 这是纯 Node 侧的单元测试，完全不涉及 CSS。
// 必须显式禁用 PostCSS，否则 Vite 会从 root 向上查找配置文件，
// 命中旧仓库根目录的 postcss.config.js（它引用了本工具没装的 autoprefixer）而报错。
export default defineConfig({
  css: {
    postcss: { plugins: [] },
  },
  // Vite 的 SSR 外部化列表不认识较新的 node 内置模块：它会把 `node:sqlite`
  // 剥成 `sqlite` 然后解析失败。显式声明为外部依赖，交给 Node 直接 require。
  ssr: {
    external: ['node:sqlite'],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      deps: {
        external: [/^node:/],
      },
    },
    // fixture 会创建并删除临时目录，串行执行更省事也更好排查
    fileParallelism: false,
  },
});
