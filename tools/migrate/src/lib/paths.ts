// 路径校验工具。
//
// 迁移 CLI 会读取运维通过命令行指定的若干路径（旧库文件、旧站 .env、
// 纹理目录）。这些路径通常来自脚本或运维手册，但在自动化场景下也可能被
// 上游变量拼接出来，因此在这里做统一规范化与类型校验：
//   • 拒绝含 `..` 段的输入，避免路径逃逸
//   • 统一解析为绝对路径，后续所有比较都在绝对路径上进行
//   • 校验目标是常规文件（而不是目录、符号链接环或设备文件）
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export class PathValidationError extends Error {}

/** 拒绝任何含 `..` 路径段的输入 */
function assertNoParentTraversal(input: string, label: string): void {
  const segments = input.split(/[/\\]+/);
  if (segments.includes('..')) {
    throw new PathValidationError(
      `${label} 含 ".." 路径段，已拒绝: ${input}\n` +
      `请传入规范化后的绝对路径或相对路径。`,
    );
  }
}

/**
 * 校验并解析一个"必须存在的常规文件"路径。
 * 返回规范化后的绝对路径。
 */
export function resolveExistingFile(input: string, label: string): string {
  if (!input) throw new PathValidationError(`${label} 为空`);
  assertNoParentTraversal(input, label);

  const abs = resolve(input);
  if (!existsSync(abs)) {
    throw new PathValidationError(`${label} 不存在: ${abs}`);
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    throw new PathValidationError(
      `${label} 不是常规文件（可能是目录或设备）: ${abs}`,
    );
  }
  return abs;
}

/**
 * 校验并解析一个"必须存在的目录"路径。
 * 返回规范化后的绝对路径。
 */
export function resolveExistingDir(input: string, label: string): string {
  if (!input) throw new PathValidationError(`${label} 为空`);
  assertNoParentTraversal(input, label);

  const abs = resolve(input);
  if (!existsSync(abs)) {
    throw new PathValidationError(`${label} 不存在: ${abs}`);
  }
  if (!statSync(abs).isDirectory()) {
    throw new PathValidationError(`${label} 不是目录: ${abs}`);
  }
  return abs;
}

/**
 * 判断 child 是否位于 parent 之内（含自身）。
 * 两个参数都必须是已规范化的绝对路径。
 */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * 读取一个运维指定的小文本文件（典型用途：旧站 .env）。
 *
 * 校验与读取刻意放在同一个函数里、紧邻执行：调用方无法绕过校验，
 * 也不存在"校验的是 A、读的是 B"的窗口。文件必须是常规文件且路径不含 `..`。
 */
export function readValidatedTextFile(input: string, label: string): string {
  const safePath = resolveExistingFile(input, label);
  return readFileSync(safePath, 'utf8');
}
