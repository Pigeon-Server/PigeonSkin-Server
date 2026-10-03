// ESLint 扁平配置。
//
// 定位：轻量守门，不是风格警察。格式交给编辑器/团队习惯，
// 这里只抓真正会出问题的东西：未使用变量、不可达代码、
// 显式 any 泄漏、测试里的敏感疏漏。
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.wrangler/**',
      '**/.mimosa/**',
      '**/.cache/**',
      'apps/web/public/blockbench/**',
      'apps/web/public/live2d/**',
      'vendor/**',        // 第三方上游源码（git submodule），不检查
      'old/**',           // 旧 Laravel 项目不检查
      'apps/web/dist/**',
      'tools/cpu-probe/**', // 一次性探针
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['**/*.ts'],
  })),
  {
    files: ['tools/**/*.mjs', 'apps/web/scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['apps/web/public/editor-*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off', // Worker 里 console 是结构化日志的正规通道
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      // 路径/文件名/记录号的输入消毒刻意匹配控制字符（\x00-\x1f），
      // 这是规则的误报场景而非代码异味。
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 测试与配置文件放宽
    files: ['**/*.test.ts', '**/test/**/*.ts', '**/*.config.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
