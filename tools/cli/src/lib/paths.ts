// 运维传入的文件路径统一校验 —— 与 tools/migrate/lib/paths.ts 同一原则：
// 校验与读取在同一处完成，避免"校验的是 A、读的是 B"的窗口。
// 拒绝 .. 路径段；export 输出路径允许不存在（目录会创建）。

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export class PathValidationError extends Error {}

function rejectUnsafe(input: string, label: string): string {
  if (!input) throw new PathValidationError(`${label} 路径为空`);
  const segments = input.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new PathValidationError(`${label} 含 ".." 路径段，已拒绝: ${input}`);
  }
  return resolve(input);
}

export function resolveExistingFile(input: string, label: string): string {
  const abs = rejectUnsafe(input, label);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new PathValidationError(`${label} 不是存在的文件: ${abs}`);
  }
  return abs;
}

export function resolveExistingDir(input: string, label: string): string {
  const abs = rejectUnsafe(input, label);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new PathValidationError(`${label} 不是存在的目录: ${abs}`);
  }
  return abs;
}

/** 输出目标：允许不存在（父目录会创建），但拒绝 .. 段 */
export function resolveOutputPath(input: string, label: string): string {
  return rejectUnsafe(input, label);
}

/** 输出文件基础名：仅允许安全字符，防止路径注入到归档结构 */
export function safeBaseName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new PathValidationError(`文件名不合法（仅允许字母数字 . _ -）: ${name}`);
  }
  return name;
}
