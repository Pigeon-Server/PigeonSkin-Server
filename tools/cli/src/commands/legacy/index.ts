// legacy 命令组：从旧 Blessing Skin（PHP 版）安装目录自动发现数据源，
// 复用 tools/migrate 的 analyze 与 stages 映射层，经 CLI 的 wrangler 通道写入目标库。
//
// 数据源两种，自动探测：
//   1. 直连 MySQL —— 读 <dir>/.env 的 DB_* 连接信息（要求 MySQL 可达）
//   2. phpMyAdmin SQL dump —— 目录内 *.sql，解析后灌入临时 SQLite 只读使用
//
// 目标：--env 对应的 D1（local bs-dev / remote bs-prod）+ R2 纹理对象。

import { resolveExistingDir, resolveExistingFile, PathValidationError } from '../../lib/paths.ts';
import { flagString, hasFlag, flagInt, type ParsedArgs } from '../../lib/args.ts';
import type { TargetEnv } from '../../lib/env.ts';
import { runLegacyAnalyze, runLegacyMigrate } from './migrate-run.ts';

export async function runLegacy(env: TargetEnv, action: string, parsed: ParsedArgs): Promise<number> {
  const { flags } = parsed;
  switch (action) {
    case 'analyze': return runLegacyAnalyze(env, flags);
    case 'migrate': return runLegacyMigrate(env, flags);
    default:
      throw new Error(`未知 legacy 子命令 "${action}"（可用: analyze | migrate）`);
  }
}

export { resolveExistingDir, resolveExistingFile, PathValidationError, flagString, hasFlag, flagInt };
