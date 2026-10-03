// @pigeon-skin/auth —— 密码与令牌。
//
// 这个包被 apps/api 与 tools/migrate **同时**引用，这是有意的：
// 迁移工具必须能离线验证旧哈希，API 必须在登录时验证它们。
// 如果写成两份实现，它们必然漂移，而漂移的校验器意味着用户登不进来。
// 只 import 本模块**实际用到**的符号；其余通过下面的 export ... from 再导出，
// 避免 noUnusedLocals 报错（import 后再 re-export 会被视为未使用）。
import { needsRehash as pbkdf2NeedsRehash, verifyPbkdf2Payload } from './password.ts';
import { LEGACY_VERIFIERS } from './legacy.ts';

export {
  hashPassword,
  verifyPbkdf2Payload,
  readPbkdf2Iterations,
  constantTimeEqual,
  PBKDF2_DEFAULT_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
} from './password.ts';

export {
  LEGACY_VERIFIERS,
  PWD_METHOD_TO_ALGO,
  ALGOS_REQUIRING_LEGACY_SALT,
  type LegacyVerifier,
} from './legacy.ts';

/**
 * 存储格式：`<algo>:<payload>`，以**第一个** `:` 分割。
 *
 * 用 `:` 而不是 `$` 是必须的：bcrypt 的 PHC 串本身以 `$2y$...` 开头，
 * 用 `$` 切分会吃掉它的前导 `$`（`'$2y$10$x'.split('$')[0]` 是空串，
 * 于是整个哈希就被毁了）。base64url 字符集不含 `:`，所以 `:` 在载荷里不会出现。
 */
const SEPARATOR = ':';

export function splitStoredPassword(stored: string): { algo: string; payload: string } | null {
  const idx = stored.indexOf(SEPARATOR);
  if (idx <= 0) return null;
  return { algo: stored.slice(0, idx), payload: stored.slice(idx + 1) };
}

export interface VerifyOptions {
  /** 旧站的 SALT 环境变量值；仅 SALTED2* 需要 */
  readonly legacySalt?: string;
}

/**
 * 校验密码。
 *
 * 按存储值的**算法段**分发，绝不嗅探哈希字符串的形态：
 * 裸十六进制家族有歧义（64 位既可能是 sha256 也可能是 salted2sha256），
 * 猜错就等于用户登不进来。算法段来自迁移时记录的 PWD_METHOD，是权威信息。
 */
export async function verifyStoredPassword(
  password: string,
  stored: string,
  options: VerifyOptions = {},
): Promise<boolean> {
  const split = splitStoredPassword(stored);
  if (!split) return false;
  const { algo, payload } = split;

  if (algo === 'pbkdf2') {
    return verifyPbkdf2Payload(password, payload);
  }

  const verifier = LEGACY_VERIFIERS[algo];
  if (!verifier) {
    // 未知算法不能当作校验失败静默放过 —— 那会掩盖配置错误
    throw new Error(`未知的密码算法段: ${algo}`);
  }
  return verifier(password, payload, options.legacySalt ?? '');
}

/**
 * 是否需要在下次成功登录时重哈希为当前算法。
 *
 * 迁移来的旧哈希全部返回 true，因此旧哈希会在用户首次登录后逐步消失，
 * 不需要批处理任务，也不需要强制动作。
 */
export function needsRehash(stored: string): boolean {
  const split = splitStoredPassword(stored);
  if (!split || split.algo !== 'pbkdf2') return true;
  return pbkdf2NeedsRehash(split.payload);
}

/**
 * 把旧哈希包装成新的自描述格式。
 *
 * 迁移工具用它把旧库 `users.password` 里的裸哈希转成 `<algo>:<hash>`，
 * 其中 algo 来自旧站 .env 的 PWD_METHOD（部署级设置，不在行里）。
 */
export function wrapLegacyHash(algo: string, rawHash: string): string {
  if (!LEGACY_VERIFIERS[algo]) {
    throw new Error(`未知的旧密码算法: ${algo}`);
  }
  return `${algo}${SEPARATOR}${rawHash}`;
}

// ── 不透明令牌 ───────────────────────────────────────────────────────────────
// 用于会话与邮件令牌。原始令牌只出现在 Cookie / 邮件链接里，
// 数据库只存它的 SHA-256，这样即使库被读走也拿不到可用的令牌。

const TOKEN_BYTES = 32;

/** 生成一个不透明令牌（base64url，43 字符） */
export function mintOpaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** 令牌的存储形式：SHA-256 十六进制 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 生成一个令牌并返回它的存储形式，避免调用方忘记哈希 */
export async function mintTokenWithHash(): Promise<{ token: string; tokenHash: string }> {
  const token = mintOpaqueToken();
  return { token, tokenHash: await hashToken(token) };
}
