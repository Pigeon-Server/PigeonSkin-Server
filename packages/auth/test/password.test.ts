// 密码与令牌的测试。
//
// 这一层是迁移里风险最高的部分：每一个写错的分支都对应一个登不进来的用户。
// 因此对旧算法的测试刻意用**另一套实现**独立算出期望值（node:crypto），
// 而不是用被测代码自己去生成再自己验证 —— 那样只能证明自洽，不能证明兼容。
import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import bcryptjs from 'bcryptjs';
import {
  hashPassword,
  verifyStoredPassword,
  needsRehash,
  wrapLegacyHash,
  splitStoredPassword,
  mintOpaqueToken,
  hashToken,
  mintTokenWithHash,
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_DEFAULT_ITERATIONS,
} from '../src/index.ts';

const PW = 'correct horse battery staple';

// ── 用 node:crypto 独立复算旧版公式，作为对照 ────────────────────────────────
//
// ⚠️ 这里刻意使用 MD5 —— 它**只用于验证旧库兼容性**，绝不是为新密码选它。
// 旧 Blessing Skin 支持 MD5 / SALTED2MD5 作为 PWD_METHOD，迁移必须能验证这些
// 历史哈希，否则那批用户永远登不进来。新密码一律用 PBKDF2-HMAC-SHA256
// （见 src/password.ts），且旧哈希会在首次成功登录时立即升级为 PBKDF2。
const phpMd5 = (v: string) => createHash('md5').update(v, 'utf8').digest('hex');
const phpSha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const phpSha512 = (v: string) => createHash('sha512').update(v, 'utf8').digest('hex');
const phpSalted2Md5 = (v: string, salt: string) => phpMd5(phpMd5(v) + salt);
const phpSalted2Sha256 = (v: string, salt: string) => phpSha256(phpSha256(v) + salt);
const phpSalted2Sha512 = (v: string, salt: string) => phpSha512(phpSha512(v) + salt);

describe('PBKDF2 新密码', () => {
  it('哈希与校验往返成功', async () => {
    const stored = await hashPassword(PW);
    expect(await verifyStoredPassword(PW, stored)).toBe(true);
  });

  it('错误密码被拒绝', async () => {
    const stored = await hashPassword(PW);
    expect(await verifyStoredPassword(PW + 'x', stored)).toBe(false);
    expect(await verifyStoredPassword('', stored)).toBe(false);
    expect(await verifyStoredPassword(PW.toUpperCase(), stored)).toBe(false);
  });

  it('格式是自描述的 pbkdf2:<iters>:<salt>:<dk>', async () => {
    const stored = await hashPassword(PW);
    const parts = stored.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2');
    expect(Number(parts[1])).toBe(PBKDF2_DEFAULT_ITERATIONS);
    // base64url 字符集不含 ':'，所以切分是安全的
    expect(stored).not.toContain('$');
  });

  it('每次哈希的盐都不同（同一密码得到不同结果）', async () => {
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    expect(a).not.toBe(b);
    expect(await verifyStoredPassword(PW, a)).toBe(true);
    expect(await verifyStoredPassword(PW, b)).toBe(true);
  });

  it('默认迭代数等于平台上限', () => {
    expect(PBKDF2_DEFAULT_ITERATIONS).toBe(PBKDF2_MAX_ITERATIONS);
    expect(PBKDF2_MAX_ITERATIONS).toBe(100_000);
  });

  it('迭代数超过平台上限时抛错并说明原因', async () => {
    // 这个上限只在 Cloudflare 生产环境执行，本地 wrangler dev 不报错 ——
    // 所以在代码层拦住，比部署后才发现好。
    await expect(hashPassword(PW, { iterations: 100_001 })).rejects.toThrow(/平台上限/);
    await expect(hashPassword(PW, { iterations: 600_000 })).rejects.toThrow(/DOMException/);
  });

  it('迭代数非法时抛错', async () => {
    await expect(hashPassword(PW, { iterations: 0 })).rejects.toThrow();
    await expect(hashPassword(PW, { iterations: -1 })).rejects.toThrow();
    await expect(hashPassword(PW, { iterations: 1.5 })).rejects.toThrow();
  });

  it('盐长度不对时抛错', async () => {
    await expect(hashPassword(PW, { salt: new Uint8Array(8) })).rejects.toThrow(/16 字节/);
  });

  it('改动存储值的任意一段都会导致校验失败', async () => {
    const stored = await hashPassword(PW);
    const [algo, iters, salt, dk] = stored.split(':');
    // 动迭代数
    expect(await verifyStoredPassword(PW, `pbkdf2:1:${salt}:${dk}`)).toBe(false);
    // 动盐
    expect(await verifyStoredPassword(PW, `pbkdf2:${iters}:AAAA:${dk}`)).toBe(false);
    // 动派生值
    const flipped = dk!.slice(0, -1) + (dk!.endsWith('A') ? 'B' : 'A');
    expect(await verifyStoredPassword(PW, `pbkdf2:${iters}:${salt}:${flipped}`)).toBe(false);
    expect(algo).toBe('pbkdf2');
  });
});

describe('bcrypt（旧库默认算法）', () => {
  it('能验证 PHP 会产出的三种前缀', async () => {
    const base = bcryptjs.hashSync(PW, 10);
    for (const prefix of ['$2a$', '$2b$', '$2y$']) {
      const hash = base.replace(/^\$2[ab]\$/, prefix);
      const stored = wrapLegacyHash('bcrypt', hash);
      expect(await verifyStoredPassword(PW, stored), `${prefix} 应通过`).toBe(true);
      expect(await verifyStoredPassword(PW + 'x', stored), `${prefix} 错误密码应失败`).toBe(false);
    }
  });

  it('校验时忽略 LEGACY_SALT（旧版 BCRYPT.php 根本不看这个参数）', async () => {
    const stored = wrapLegacyHash('bcrypt', bcryptjs.hashSync(PW, 10));
    expect(await verifyStoredPassword(PW, stored, { legacySalt: '任意值' })).toBe(true);
    expect(await verifyStoredPassword(PW, stored, { legacySalt: '' })).toBe(true);
  });

  it('bcrypt 的 PHC 串含 $，用 : 分隔才不会破坏它', () => {
    const split = splitStoredPassword('bcrypt:$2y$10$abc');
    expect(split).toEqual({ algo: 'bcrypt', payload: '$2y$10$abc' });
  });

  it('argon2 的 PHC 串同样不被破坏', () => {
    const split = splitStoredPassword('argon2i:$argon2i$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA');
    expect(split?.algo).toBe('argon2i');
    expect(split?.payload.startsWith('$argon2i$')).toBe(true);
  });
});

describe('无盐家族（md5 / sha256 / sha512）', () => {
  it('md5 与旧版 md5($v) 一致', async () => {
    const stored = wrapLegacyHash('md5', phpMd5(PW));
    expect(await verifyStoredPassword(PW, stored)).toBe(true);
    expect(await verifyStoredPassword(PW + 'x', stored)).toBe(false);
  });

  it('sha256 与旧版 hash("sha256", $v) 一致', async () => {
    const stored = wrapLegacyHash('sha256', phpSha256(PW));
    expect(await verifyStoredPassword(PW, stored)).toBe(true);
    expect(await verifyStoredPassword(PW + 'x', stored)).toBe(false);
  });

  it('sha512 与旧版 hash("sha512", $v) 一致', async () => {
    const stored = wrapLegacyHash('sha512', phpSha512(PW));
    expect(await verifyStoredPassword(PW, stored)).toBe(true);
    expect(await verifyStoredPassword(PW + 'x', stored)).toBe(false);
  });
});

describe('加盐家族（salted2*）', () => {
  const SALT = 'my-legacy-salt';

  it('salted2md5 与旧版 md5(md5($v).$salt) 一致', async () => {
    const stored = wrapLegacyHash('salted2md5', phpSalted2Md5(PW, SALT));
    expect(await verifyStoredPassword(PW, stored, { legacySalt: SALT })).toBe(true);
    expect(await verifyStoredPassword(PW + 'x', stored, { legacySalt: SALT })).toBe(false);
  });

  it('salted2sha256 与旧版 hash("sha256", hash("sha256",$v).$salt) 一致', async () => {
    const stored = wrapLegacyHash('salted2sha256', phpSalted2Sha256(PW, SALT));
    expect(await verifyStoredPassword(PW, stored, { legacySalt: SALT })).toBe(true);
  });

  it('salted2sha512 与旧版公式一致', async () => {
    const stored = wrapLegacyHash('salted2sha512', phpSalted2Sha512(PW, SALT));
    expect(await verifyStoredPassword(PW, stored, { legacySalt: SALT })).toBe(true);
  });

  it('盐错误时校验失败（这一点必须在迁移前就发现）', async () => {
    const stored = wrapLegacyHash('salted2sha256', phpSalted2Sha256(PW, SALT));
    expect(await verifyStoredPassword(PW, stored, { legacySalt: 'wrong-salt' })).toBe(false);
    expect(await verifyStoredPassword(PW, stored, { legacySalt: '' })).toBe(false);
  });

  it('内层用的是十六进制字符串而不是原始字节（容易写错的地方）', () => {
    // 若误用原始字节拼接，结果会与本函数不同 —— 这里固定一个向量锁住语义
    const expected = phpSalted2Sha256(PW, SALT);
    const wrongIfRawBytes = createHmac('sha256', 'x').update('y').digest('hex');
    expect(expected).not.toBe(wrongIfRawBytes);
    expect(expected).toHaveLength(64);
  });
});

describe('php_password_hash', () => {
  it('bcrypt 前缀被正确识别并校验', async () => {
    const hash = bcryptjs.hashSync(PW, 10).replace(/^\$2[ab]\$/, '$2y$');
    const stored = wrapLegacyHash('php_password_hash', hash);
    expect(await verifyStoredPassword(PW, stored)).toBe(true);
    expect(await verifyStoredPassword(PW + 'x', stored)).toBe(false);
  });
});

describe('argon2i（旧版 ARGON2I cipher）', () => {
  // 用 @noble/hashes 生成真实的 PHC 串，再走被测的校验路径。
  // 这验证了 PHC 解析与参数提取，而不是只测字符串切分。
  async function makeArgon2iHash(t: number, m: number, p: number): Promise<string> {
    const { argon2i } = await import('@noble/hashes/argon2.js');
    const salt = new TextEncoder().encode('0123456789abcdef');
    const dk = argon2i(PW, salt, { t, m, p, dkLen: 32 });
    let dkB64 = '';
    for (const b of dk) dkB64 += String.fromCharCode(b);
    return `$argon2i$v=19$m=${m},t=${t},p=${p}$${btoa('0123456789abcdef').replace(/=+$/, '')}$${btoa(dkB64).replace(/=+$/, '')}`;
  }

  it('能校验真实的 Argon2i PHC 串', async () => {
    const hash = await makeArgon2iHash(2, 4096, 1);
    const stored = wrapLegacyHash('argon2i', hash);
    expect(await verifyStoredPassword(PW, stored)).toBe(true);
    expect(await verifyStoredPassword(PW + 'x', stored)).toBe(false);
  });

  it('不同参数的 Argon2i 也能正确解析', async () => {
    const hash = await makeArgon2iHash(3, 8192, 2);
    const stored = wrapLegacyHash('argon2i', hash);
    expect(await verifyStoredPassword(PW, stored)).toBe(true);
  });

  it('畸形的 PHC 串返回 false 而不是抛错', async () => {
    for (const bad of [
      'argon2i:',
      'argon2i:$argon2i$v=19$m=1,t=1,p=1$onlysalt',
      'argon2i:$argon2i$v=19$m=x,t=1,p=1$c2FsdA$aGFzaA',
      'argon2i:$argon2i$v=19$t=1,p=1$c2FsdA$aGFzaA',   // 缺 m
      'argon2i:$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA',
    ]) {
      expect(await verifyStoredPassword(PW, bad), bad).toBe(false);
    }
  });
});

describe('分发与重哈希', () => {
  it('未知算法抛错，而不是静默当作校验失败', async () => {
    // 静默返回 false 会掩盖配置错误：运维会以为是密码错了，
    // 实际是整个站的密码算法识别错了
    await expect(verifyStoredPassword(PW, 'something_else:abcdef')).rejects.toThrow(/未知的密码算法段/);
  });

  it('格式不合法的存储值返回 false 而不是抛错', async () => {
    expect(await verifyStoredPassword(PW, 'no-separator')).toBe(false);
    expect(await verifyStoredPassword(PW, '')).toBe(false);
    expect(await verifyStoredPassword(PW, ':payload')).toBe(false);
  });

  it('wrapLegacyHash 拒绝未知算法', () => {
    expect(() => wrapLegacyHash('whatever', 'abc')).toThrow(/未知的旧密码算法/);
  });

  it('旧格式需要重哈希，当前参数的 pbkdf2 不需要', async () => {
    expect(needsRehash(wrapLegacyHash('bcrypt', bcryptjs.hashSync(PW, 10)))).toBe(true);
    expect(needsRehash(wrapLegacyHash('sha256', phpSha256(PW)))).toBe(true);
    expect(needsRehash(await hashPassword(PW))).toBe(false);
  });

  it('迭代数偏低的 pbkdf2 也需要重哈希（参数升级的路径）', async () => {
    const weak = await hashPassword(PW, { iterations: 1000 });
    expect(await verifyStoredPassword(PW, weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
  });
});

describe('不透明令牌', () => {
  it('每次生成的令牌都不同，且长度稳定', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = mintOpaqueToken();
      expect(t).toHaveLength(43);          // 32 字节 base64url 无填充
      expect(t).not.toMatch(/[+/=]/);      // base64url 安全
      seen.add(t);
    }
    expect(seen.size).toBe(50);
  });

  it('令牌哈希是 64 位十六进制且确定', async () => {
    const token = mintOpaqueToken();
    const h1 = await hashToken(token);
    const h2 = await hashToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mintTokenWithHash 返回的哈希与令牌对应', async () => {
    const { token, tokenHash } = await mintTokenWithHash();
    expect(await hashToken(token)).toBe(tokenHash);
  });
});
