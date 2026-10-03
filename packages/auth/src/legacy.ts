// 旧 Blessing Skin 的九种密码校验器。
//
// 这是整个迁移里**风险最高**的一块：每一个写错的分支都对应一个登不进来的用户。
// 因此实现严格照抄旧版 app/Services/Cipher/ 的语义：
//
//   BCRYPT            password_hash($v, PASSWORD_BCRYPT)          → $2y$...
//   ARGON2I           password_hash($v, PASSWORD_ARGON2I)         → $argon2i$...
//   PHP_PASSWORD_HASH password_hash($v, PASSWORD_DEFAULT)         → PHP 8 上是 $2y$...
//   MD5               md5($v)
//   SALTED2MD5        md5(md5($v) . $salt)
//   SHA256            hash('sha256', $v)
//   SALTED2SHA256     hash('sha256', hash('sha256', $v) . $salt)
//   SHA512            hash('sha512', $v)
//   SALTED2SHA512     hash('sha512', hash('sha512', $v) . $salt)
//
// 两个让常见情况变简单的事实：
//
//   1. **默认路径不需要盐。** `BCRYPT.php:9` 调 `password_hash($value, PASSWORD_BCRYPT)`
//      时**完全忽略** `$salt` 参数。`config('secure.salt')` 被传进来了但没被使用。
//      所以默认安装的哈希用纯 bcrypt 就能验证，不需要额外密钥。
//   2. **非 password_hash 系列就是简单相等比较。**
//      `BaseCipher::verify()` 是 `hash_equals($hash, $this->hash($password, $salt))`。
import bcryptjs from 'bcryptjs';
import { md5 } from '@noble/hashes/legacy.js';
import { argon2i } from '@noble/hashes/argon2.js';
import { constantTimeEqual } from './password.ts';

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=+$/, '');
}

async function shaHex(algorithm: 'SHA-256' | 'SHA-512', text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest(algorithm, encoder.encode(text))));
}

/** 所有旧校验器的统一签名：接收算法名之后的载荷 */
export type LegacyVerifier = (
  password: string,
  payload: string,
  legacySalt: string,
) => Promise<boolean>;

// ── bcrypt 家族 ──────────────────────────────────────────────────────────────

/**
 * 校验 bcrypt 哈希。PHP 的 `$2y$` 与 `$2a$`/`$2b$` 是同一算法，
 * 只差边界处理的历史标记，bcryptjs 三种前缀都能处理（已实测）。
 */
async function verifyBcrypt(password: string, payload: string): Promise<boolean> {
  // bcrypt 的有效输入上限是 72 字节。旧版注册校验是 max:32 字符，
  // 所以正常数据不会触及边界；这里仍做截断以匹配 PHP 的行为。
  if (encoder.encode(password).length > 72) return false;
  try {
    return await bcryptjs.compare(password, payload);
  } catch {
    return false;
  }
}

// ── Argon2i（PHP 的 PASSWORD_ARGON2I）────────────────────────────────────────

/**
 * 解析并校验 PHC 格式的 Argon2i 哈希：
 *   $argon2i$v=19$m=65536,t=3,p=4$<salt-b64>$<hash-b64>
 *
 * 容忍可选的前导 `$`：存储格式 `<algo>:<payload>` 里 payload 可能带也可能不带它
 * （`argon2i:$argon2i$...` 与 `argon2i:argon2i$...` 都要能处理）。
 */
async function verifyArgon2i(password: string, payload: string): Promise<boolean> {
  const normalized = payload.startsWith('$') ? payload.slice(1) : payload;
  const parts = normalized.split('$');
  if (parts.length !== 5) return false;
  const [variant, version, params, saltB64, hashB64] = parts;
  if (variant !== 'argon2i' || !version?.startsWith('v=') || !params || !saltB64 || !hashB64) {
    return false;
  }

  const opts: Record<string, number> = {};
  for (const kv of params.split(',')) {
    const [k, v] = kv.split('=');
    if (!k || v === undefined) return false;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return false;
    opts[k] = n;
  }
  const t = opts['t'];
  const m = opts['m'];
  const p = opts['p'];
  if (t === undefined || m === undefined || p === undefined) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(saltB64);
    expected = fromBase64(hashB64);
  } catch {
    return false;
  }

  try {
    const derived = argon2i(password, salt, { t, m, p, dkLen: expected.length });
    return constantTimeEqual(toBase64(derived), toBase64(expected));
  } catch {
    return false;
  }
}

// ── PHP_PASSWORD_HASH ────────────────────────────────────────────────────────

/**
 * `password_hash($v, PASSWORD_DEFAULT)` 在 PHP 8 上产出 bcrypt。
 * 这里按 PHC 前缀分发 —— 对 `$2y$` / `$argon2*$` 而言前缀是无歧义的，
 * 与裸十六进制家族（32/64/128 位 hex 无法区分是否加盐）不同。
 */
async function verifyPhpPasswordHash(
  password: string,
  payload: string,
): Promise<boolean> {
  // 去掉可选的前导 `$`，使 `$2y$...` 与 `2y$...` 都能识别
  const phc = payload.startsWith('$') ? payload.slice(1) : payload;

  if (phc.startsWith('2y$') || phc.startsWith('2a$') || phc.startsWith('2b$')) {
    return verifyBcrypt(password, `$${phc}`);
  }
  if (phc.startsWith('argon2i$')) return verifyArgon2i(password, phc);
  if (phc.startsWith('argon2id$')) {
    // PHP 8 的 PASSWORD_ARGON2ID 也可能被用过；旧版没有这个 cipher，但直接改库可能产生
    return verifyArgon2i(password, phc.replace(/^argon2id\$/, 'argon2i$'));
  }
  // PASSWORD_DEFAULT 未来可能变化，落到无盐家族处理
  return verifyBareHex(password, phc, 'sha256');
}

// ── 无盐家族 ─────────────────────────────────────────────────────────────────

/**
 * 无盐家族。`legacySalt` 不参与计算 —— 这几个算法在旧版里就是不加盐的，
 * 之所以保留参数位置，是因为 dispatch 层用统一签名调用所有校验器。
 */
async function verifyBareHex(
  password: string,
  payload: string,
  algo: 'md5' | 'sha256' | 'sha512',
): Promise<boolean> {
  const expected = payload;
  if (algo === 'md5') return constantTimeEqual(toHex(md5(encoder.encode(password))), expected);
  if (algo === 'sha256') return constantTimeEqual(await shaHex('SHA-256', password), expected);
  return constantTimeEqual(await shaHex('SHA-512', password), expected);
}

/**
 * 加盐家族。旧版语义是：
 *   md5(md5($password) . $salt)
 *   hash('sha256', hash('sha256', $password) . $salt)
 * 注意内层是**十六进制字符串**参与拼接，不是原始字节。
 */
async function verifySaltedHex(
  password: string,
  payload: string,
  legacySalt: string,
  algo: 'md5' | 'sha256' | 'sha512',
): Promise<boolean> {
  let inner: string;
  let outer: string;
  if (algo === 'md5') {
    inner = toHex(md5(encoder.encode(password)));
    outer = toHex(md5(encoder.encode(inner + legacySalt)));
  } else if (algo === 'sha256') {
    inner = await shaHex('SHA-256', password);
    outer = await shaHex('SHA-256', inner + legacySalt);
  } else {
    inner = await shaHex('SHA-512', password);
    outer = await shaHex('SHA-512', inner + legacySalt);
  }
  return constantTimeEqual(outer, payload);
}

// ── 注册表 ───────────────────────────────────────────────────────────────────
// 键名与旧版 PWD_METHOD 的取值一一对应（小写）。dispatch 只认这里的键，
// 绝不嗅探哈希字符串的形态 —— 32/64/128 位裸十六进制无法区分是否加盐，
// 猜错就意味着用户登不进来。

export const LEGACY_VERIFIERS: Readonly<Record<string, LegacyVerifier>> = {
  bcrypt: (pw, payload) => verifyBcrypt(pw, payload),
  argon2i: (pw, payload) => verifyArgon2i(pw, payload),
  php_password_hash: (pw, payload) => verifyPhpPasswordHash(pw, payload),

  md5: (pw, payload) => verifyBareHex(pw, payload, 'md5'),
  sha256: (pw, payload) => verifyBareHex(pw, payload, 'sha256'),
  sha512: (pw, payload) => verifyBareHex(pw, payload, 'sha512'),

  salted2md5: (pw, payload, salt) => verifySaltedHex(pw, payload, salt, 'md5'),
  salted2sha256: (pw, payload, salt) => verifySaltedHex(pw, payload, salt, 'sha256'),
  salted2sha512: (pw, payload, salt) => verifySaltedHex(pw, payload, salt, 'sha512'),
};

/** 旧站 .env 的 PWD_METHOD → 本模块的算法键 */
export const PWD_METHOD_TO_ALGO: Readonly<Record<string, string>> = {
  BCRYPT: 'bcrypt',
  ARGON2I: 'argon2i',
  PHP_PASSWORD_HASH: 'php_password_hash',
  MD5: 'md5',
  SALTED2MD5: 'salted2md5',
  SHA256: 'sha256',
  SALTED2SHA256: 'salted2sha256',
  SHA512: 'sha512',
  SALTED2SHA512: 'salted2sha512',
};

/** 需要旧站 SALT 环境变量的算法。bcrypt/argon2 的盐在哈希串里，不需要。 */
export const ALGOS_REQUIRING_LEGACY_SALT: ReadonlySet<string> = new Set([
  'salted2md5', 'salted2sha256', 'salted2sha512',
]);
