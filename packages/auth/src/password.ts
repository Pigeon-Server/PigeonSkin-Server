// 新密码哈希：PBKDF2-HMAC-SHA256，走 WebCrypto 原生实现。
//
// 为什么是它，而不是 Argon2id —— 这是**实测**出来的结论，不是偏好：
//
//   1. Workers 禁止运行时编译 WASM（`WebAssembly.compile(bytes)` 抛
//      `CompileError: Wasm code generation disallowed by embedder`），
//      所以 hash-wasm 这类"内嵌 WASM、运行时编译"的库根本跑不起来。
//   2. 纯 JS 的 Argon2id/scrypt 可行，但生产环境比原生慢得多，且受 JIT 预热影响
//      （实测 bcryptjs 本机 104ms → 生产 337ms）。
//   3. WebCrypto 是原生实现，行为稳定可预测：PBKDF2-100k 在 15 次独立请求里
//      稳定在 70–72ms。
//
// ⚠️ 100,000 次迭代是 **Cloudflare 强制的上限**（100001 会抛
//    `DOMException: iteration counts above 100000 are not supported`），
//    而 OWASP 对 PBKDF2-SHA256 的建议是 600,000 —— 差 6 倍。
//    这是本方案唯一的实质性安全让步。消除它需要自己编译 Argon2 的独立 .wasm
//    作为模块导入（机制已验证可行、无迭代上限），列为后续改进项。

/**
 * Cloudflare 生产环境强制的迭代数上限。
 * 注意 `wrangler dev` 本地**不执行**这个限制 —— 400k 在本地跑得好好的，
 * 只有部署后才会抛 DOMException。这个坑值得在代码里写清楚。
 */
export const PBKDF2_MAX_ITERATIONS = 100_000;

/** 迭代数。取平台允许的最大值，以尽量缩小与 OWASP 建议的差距。 */
export const PBKDF2_DEFAULT_ITERATIONS = PBKDF2_MAX_ITERATIONS;

/** 派生密钥长度（字节） */
const DK_LEN_BYTES = 32;

/** 盐长度（字节） */
const SALT_BYTES = 16;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 常量时间比较。长度不同直接返回 false —— 长度本身不是秘密
 * （派生密钥长度固定），提前返回可避免无谓比较。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 注意 TS 5.7+ 把 Uint8Array 变成了泛型（Uint8Array<ArrayBufferLike>），
// 而 WebCrypto 的 BufferSource 要求底层是 ArrayBuffer 而非 SharedArrayBuffer，
// 所以这里显式写成 Uint8Array<ArrayBuffer>。
async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, DK_LEN_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * 生成新密码的存储值。
 *
 * 格式：`pbkdf2:<iterations>:<salt-b64url>:<derived-key-b64url>`
 *
 * 分隔符用 `:` 而不是 `$`，因为 bcrypt 的 PHC 串本身以 `$2y$...` 开头，
 * 用 `$` 切分会吃掉它的前导 `$`（`'$2y$10$x'.split('$')[0]` 是空串）。
 * base64url 字符集不含 `:`，所以 `:` 在载荷里不会出现。
 *
 * 用自描述字符串而不是"单列哈希 + 单独的算法列"，是为了迁移期混存：
 * 老用户的 bcrypt/md5/sha 哈希和新用户的 pbkdf2 同时存在一列里，
 * 按第一段分发即可，不会出现"算法列与哈希值不一致"的中间状态。
 */
export async function hashPassword(
  password: string,
  options: { iterations?: number; salt?: Uint8Array<ArrayBuffer> } = {},
): Promise<string> {
  const iterations = options.iterations ?? PBKDF2_DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`迭代数必须是正整数，收到 ${iterations}`);
  }
  if (iterations > PBKDF2_MAX_ITERATIONS) {
    throw new Error(
      `迭代数 ${iterations} 超过 Cloudflare 平台上限 ${PBKDF2_MAX_ITERATIONS}；` +
      `生产环境会抛 DOMException（本地 wrangler dev 不报错，别被本地骗了）。`,
    );
  }
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  if (salt.length !== SALT_BYTES) {
    throw new Error(`盐必须是 ${SALT_BYTES} 字节，收到 ${salt.length}`);
  }
  const derived = await deriveKey(password, salt, iterations);
  return `pbkdf2:${iterations}:${toBase64Url(salt)}:${toBase64Url(derived)}`;
}

/**
 * 校验 PBKDF2 存储值。
 * @param payload 算法名之后的载荷，即 `<iterations>:<salt>:<dk>`
 */
export async function verifyPbkdf2Payload(
  password: string,
  payload: string,
): Promise<boolean> {
  const parts = payload.split(':');
  if (parts.length !== 3) return false;
  const [iterationsText, saltB64, expected] = parts;
  if (!iterationsText || !saltB64 || !expected) return false;

  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  let salt: Uint8Array<ArrayBuffer>;
  try {
    salt = fromBase64Url(saltB64);
  } catch {
    return false;
  }
  const derived = await deriveKey(password, salt, iterations);
  return constantTimeEqual(toBase64Url(derived), expected);
}

/** 从载荷里读出迭代数，用于判断是否需要重哈希 */
export function readPbkdf2Iterations(payload: string): number | null {
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  const n = Number(parts[0]);
  return Number.isInteger(n) ? n : null;
}

/**
 * 是否已用当前推荐的迭代数哈希（false = 不需要升级）。
 *
 * 用途有两个：旧哈希升级为 PBKDF2，以及将来提高迭代数后让已有 PBKDF2
 * 哈希在下次登录时自动跟上 —— 后者正是"参数升级"的路径。
 */
export function needsRehash(payload: string): boolean {
  const iterations = readPbkdf2Iterations(payload);
  if (iterations === null) return true;
  return iterations < PBKDF2_DEFAULT_ITERATIONS;
}
