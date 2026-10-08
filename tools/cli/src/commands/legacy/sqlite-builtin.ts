// node:sqlite 的统一获取点 —— 与 tools/migrate/targets/types.ts 相同的原因：
// getBuiltinModule 对打包器/测试运行器不透明，直接 import 'node:sqlite' 在 Vitest 下会失败。

type NodeSqlite = typeof import('node:sqlite');

export function getSqlite(): NodeSqlite {
  return process.getBuiltinModule('node:sqlite') as NodeSqlite;
}
