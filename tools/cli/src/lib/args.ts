// 命令行参数解析 —— 与 tools/migrate 同一约定：
// 未知参数直接报错，不静默忽略（静默忽略是运维事故的常见来源）。
// 形态：`<命令...> --flag <值> | --flag`，布尔开关后不带值。

export interface ParsedArgs {
  /** 子命令路径，如 ['users', 'create'] */
  readonly path: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

const KNOWN_BOOLEAN_FLAGS = new Set([
  'help', 'h', 'json', 'yes', 'y', 'generate-password', 'generate', 'update', 'dry-run', 'force', 'skip-file-hash', 'skip-r2',
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const path: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      if (token === '-h') { flags.set('help', true); continue; }
      path.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === '') throw new Error(`空参数名: ${token}`);
    const next = argv[i + 1];
    if (KNOWN_BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`参数 --${name} 需要一个值`);
    }
    flags.set(name, next);
    i++;
  }
  return { path, flags };
}

export function flagString(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function hasFlag(flags: ReadonlyMap<string, string | true>, name: string): boolean {
  return flags.get(name) === true;
}

export function flagInt(flags: ReadonlyMap<string, string | true>, name: string): number | undefined {
  const v = flagString(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} 必须是正整数`);
  return n;
}

/**
 * 命令级 flag 白名单校验 —— 实现"未知参数直接报错"的约定。
 * 没有它，`users set-role --rol admin` 这种打错字会被静默忽略，
 * parseRole 收到 undefined 后默认 'normal'，直接把用户降级。
 */
export function assertKnownFlags(
  flags: ReadonlyMap<string, string | true>,
  allowed: readonly string[],
): void {
  for (const name of flags.keys()) {
    if (name === 'h' || name === 'help') continue;
    if (!allowed.includes(name)) {
      throw new Error(
        `未知参数 --${name}（"${allowed.map((a) => `--${a}`).join(' ')}" 可用）`,
      );
    }
  }
}
