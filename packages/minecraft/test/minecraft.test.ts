// 纹理校验的测试。覆盖 docs/rewrite/06-texture-architecture.md §10 的 T1–T17。
//
// 这些测试的价值在于"拦住畸形输入"：用真实图片造不出 CRC 损坏、
// IEND 后追加载荷这类样本，所以畸形样本由 test/png-builder.ts 专门构造。
import { describe, it, expect } from 'vitest';
import { inspectPng, sha256Hex } from '../src/png.ts';
import { validateTexture, textureObjectKey, isAllowedDerivativeSize } from '../src/texture.ts';
import {
  buildPlayerProfile,
  serializePlayerProfile,
} from '../src/csl.ts';
import { makePng, makeFakeJpeg } from './png-builder.ts';
import { LIMITS } from '@pigeon-skin/shared';

const SKIN_DEFAULT = { kind: 'skin', model: 'default' } as const;
const SKIN_SLIM = { kind: 'skin', model: 'slim' } as const;
const CAPE = { kind: 'cape', model: null } as const;

// ── 结构校验 ─────────────────────────────────────────────────────────────────

describe('inspectPng — 结构', () => {
  it('接受合法 PNG 并读出尺寸', () => {
    const r = inspectPng(makePng({ width: 64, height: 64 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.width).toBe(64);
      expect(r.info.height).toBe(64);
      expect(r.info.chunkTypes).toEqual(['IHDR', 'IDAT', 'IEND']);
    }
  });

  it('接受灰度、调色板等其它合法颜色类型（它们都是合法的 PNG 容器）', () => {
    for (const colorType of [0, 2, 3, 4, 6]) {
      const r = inspectPng(makePng({ width: 64, height: 64, colorType }));
      expect(r.ok, `colorType=${colorType}`).toBe(true);
    }
  });

  it('允许未知的 ancillary chunk（首字母小写）', () => {
    const r = inspectPng(makePng({
      width: 64, height: 64,
      extraChunks: [{ type: 'tEXt', data: Buffer.from('k\0v', 'latin1') }],
    }));
    expect(r.ok).toBe(true);
  });
});

describe('inspectPng — 拒绝畸形输入', () => {
  it('T11 拒绝改名的 JPEG（魔数不匹配，与 Content-Type 无关）', () => {
    const r = inspectPng(makeFakeJpeg());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('texture.not_png');
  });

  it('拒绝空文件与过短文件', () => {
    expect(inspectPng(new Uint8Array(0)).ok).toBe(false);
    expect(inspectPng(new Uint8Array([0x89, 0x50])).ok).toBe(false);
  });

  it('T12 拒绝 IEND 之后追加数据的 polyglot 文件', () => {
    const r = inspectPng(makePng({
      width: 64, height: 64,
      trailingJunk: Buffer.from('<?php system($_GET["c"]); ?>', 'utf8'),
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('texture.malformed');
      expect(r.message).toMatch(/polyglot|IEND 之后/);
    }
  });

  it('T13 拒绝未知的 critical chunk', () => {
    const r = inspectPng(makePng({
      width: 64, height: 64,
      extraChunks: [{ type: 'XxXx', data: Buffer.from([1, 2, 3]) }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/未知的关键 chunk/);
  });

  it('T14 拒绝 CRC 损坏的文件', () => {
    const r = inspectPng(makePng({ width: 64, height: 64, corruptIdatCrc: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/CRC/);
  });

  it('T15 拒绝 chunk 数量超限（chunk 洪水）', () => {
    const r = inspectPng(makePng({ width: 64, height: 64, fillerChunks: LIMITS.maxPngChunks }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/chunk 数量超过上限/);
  });

  it('T16 拒绝 APNG（acTL chunk）', () => {
    const r = inspectPng(makePng({
      width: 64, height: 64,
      extraChunks: [{ type: 'acTL', data: Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]) }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('texture.animated_not_supported');
  });

  it('拒绝截断的文件（缺少 IEND）', () => {
    const r = inspectPng(makePng({ width: 64, height: 64, omitIend: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/截断|IEND/);
  });

  it('拒绝缺少 IHDR 的文件', () => {
    const r = inspectPng(makePng({ width: 64, height: 64, omitIhdr: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/IHDR/);
  });

  it('拒绝尺寸为 0 的图', () => {
    const padded = makePng({ width: 64, height: 64 });
    // 直接把 IHDR 里的宽改成 0，并修复 CRC 让结构仍然完好
    expect(inspectPng(padded).ok).toBe(true);
    // 用构造器造 0 尺寸会被 width===0 拦住
    const zero = makePng({ width: 0, height: 64 });
    expect(inspectPng(zero).ok).toBe(false);
  });
});

// ── 纹理语义规则 ─────────────────────────────────────────────────────────────

describe('validateTexture — 尺寸与宽高比（旧版规则逐条保留）', () => {
  const v = (w: number, h: number, target: typeof SKIN_DEFAULT | typeof SKIN_SLIM | typeof CAPE) =>
    validateTexture(makePng({ width: w, height: h }), target);

  it('T1 接受 64×64 的 default 皮肤', async () => {
    const r = await v(64, 64, SKIN_DEFAULT);
    expect(r.ok).toBe(true);
  });

  it('T2 接受 64×64 的 slim 皮肤', async () => {
    expect((await v(64, 64, SKIN_SLIM)).ok).toBe(true);
  });

  it('T3 接受 64×32 的 default 皮肤（比例 2）', async () => {
    expect((await v(64, 32, SKIN_DEFAULT)).ok).toBe(true);
  });

  it('T4 拒绝 64×32 声明为 slim（旧版显式拒绝）', async () => {
    const r = await v(64, 32, SKIN_SLIM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('texture.ratio_invalid');
  });

  it('T5 接受 64×32 的披风', async () => {
    expect((await v(64, 32, CAPE)).ok).toBe(true);
  });

  it('T6 拒绝 64×64 的披风（披风必须比例 2）', async () => {
    const r = await v(64, 64, CAPE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('texture.ratio_invalid');
  });

  it('T7 拒绝 22×17（不是 64/32 的倍数）—— 与旧版一致', async () => {
    const r = await v(22, 17, SKIN_DEFAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('texture.dimension_invalid');
  });

  it('T8 拒绝 65×64（宽不是 64 的倍数）', async () => {
    const r = await v(65, 64, SKIN_DEFAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('texture.dimension_invalid');
  });

  it('接受 128×128 与 128×64 的高清皮肤', async () => {
    expect((await v(128, 128, SKIN_DEFAULT)).ok).toBe(true);
    expect((await v(128, 64, SKIN_DEFAULT)).ok).toBe(true);
  });

  it('T10 拒绝超过宽度上限的图', async () => {
    const r = await v(LIMITS.maxTextureWidth + 64, 64, SKIN_DEFAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['texture.width_too_large', 'texture.dimension_invalid']).toContain(r.code);
  });

  it('T9 拒绝面积超限的图（宽度、体积都合法，但面积灾难）', async () => {
    // 用自定义的面积上限来单独验证这条规则：真实的 8192×8192 图会先被
    // 文件大小上限拦住（原始像素就 268MB），测不到面积检查本身。
    // 面积检查是**独立于**尺寸与体积的第二道解压缩炸弹防护，必须单独测。
    const r = await validateTexture(
      makePng({ width: 64, height: 64 }),
      SKIN_DEFAULT,
      { maxSizeBytes: 10 * 1024 * 1024, maxWidth: 8192, maxArea: 64 * 63 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/面积/);
  });

  it('面积恰好等于上限时接受（边界）', async () => {
    const r = await validateTexture(
      makePng({ width: 64, height: 64 }),
      SKIN_DEFAULT,
      { maxSizeBytes: 10 * 1024 * 1024, maxWidth: 8192, maxArea: 64 * 64 },
    );
    expect(r.ok).toBe(true);
  });

  it('T17 在解析之前就拒绝超大文件', async () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    const r = await validateTexture(big, SKIN_DEFAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('texture.file_too_large');
  });

  it('拒绝空文件', async () => {
    const r = await validateTexture(new Uint8Array(0), SKIN_DEFAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('texture.file_missing');
  });
});

describe('validateTexture — 哈希', () => {
  it('哈希是存储字节的 sha256（内容地址不变量）', async () => {
    const bytes = makePng({ width: 64, height: 64 });
    const r = await validateTexture(bytes, SKIN_DEFAULT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.hash).toBe(await sha256Hex(bytes));
      expect(r.value.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.value.byteLength).toBe(bytes.length);
    }
  });

  it('相同字节得到相同哈希，不同字节得到不同哈希', async () => {
    const a = makePng({ width: 64, height: 64 });
    const b = makePng({ width: 64, height: 64 });
    const c = makePng({ width: 128, height: 128 });
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(c));
  });

  it('对象键由哈希直接推导（扁平、无分片）', () => {
    const hash = 'a'.repeat(64);
    expect(textureObjectKey(hash)).toBe(`textures/${hash}.png`);
  });
});

describe('衍生图尺寸白名单', () => {
  it('只允许白名单内的尺寸（旧版接受任意整数，会被用来撑爆 R2）', () => {
    for (const size of LIMITS.derivativeSizes) {
      expect(isAllowedDerivativeSize(size), `${size} 应被允许`).toBe(true);
    }
    for (const size of [1, 37, 99, 999, 1000000]) {
      expect(isAllowedDerivativeSize(size), `${size} 应被拒绝`).toBe(false);
    }
  });
});

// ── CSL 协议契约 ─────────────────────────────────────────────────────────────
// 这几条是外部契约，改动会静默破坏所有玩家的皮肤。

describe('CSL 玩家档案（外部协议，字节级契约）', () => {
  it('P1 default 皮肤 + 无披风', () => {
    const profile = buildPlayerProfile({
      playerName: 'Notch',
      skin: { hash: 'abc123', model: 'default' },
      cape: null,
    });
    expect(serializePlayerProfile(profile))
      .toBe('{"username":"Notch","skins":{"default":"abc123"},"cape":null}');
  });

  it('P2 slim 皮肤的键是 "slim"，不是 "default"', () => {
    const profile = buildPlayerProfile({
      playerName: 'Alex',
      skin: { hash: 'def456', model: 'slim' },
      cape: null,
    });
    expect(Object.keys(profile.skins)).toEqual(['slim']);
    expect(serializePlayerProfile(profile))
      .toBe('{"username":"Alex","skins":{"slim":"def456"},"cape":null}');
  });

  it('P3 皮肤与披风同时存在', () => {
    const profile = buildPlayerProfile({
      playerName: 'Caped',
      skin: { hash: 'skin1', model: 'default' },
      cape: { hash: 'cape1' },
    });
    expect(profile.skins).toEqual({ default: 'skin1' });
    expect(profile.cape).toBe('cape1');
  });

  it('P4 无皮肤时是 {"default": null} —— 键存在、值为 null，不是省略也不是空串', () => {
    const profile = buildPlayerProfile({ playerName: 'NoSkin', skin: null, cape: null });
    expect(profile.skins).toEqual({ default: null });
    expect(serializePlayerProfile(profile))
      .toBe('{"username":"NoSkin","skins":{"default":null},"cape":null}');
    // 明确锁住"键必须存在"
    expect('default' in profile.skins).toBe(true);
  });

  it('P5 无披风时 cape 为 null，而不是省略该字段', () => {
    const profile = buildPlayerProfile({
      playerName: 'X', skin: { hash: 'h', model: 'default' }, cape: null,
    });
    expect(serializePlayerProfile(profile)).toContain('"cape":null');
  });

  it('披风不参与 model 判定：有披风但无皮肤时仍然是 "default"', () => {
    const profile = buildPlayerProfile({
      playerName: 'CapeOnly', skin: null, cape: { hash: 'c' },
    });
    expect(Object.keys(profile.skins)).toEqual(['default']);
  });

  it('skins 恰好只有 1 个键（不是 default/slim 两键并存）', () => {
    for (const model of ['default', 'slim'] as const) {
      const profile = buildPlayerProfile({
        playerName: 'P', skin: { hash: 'h', model }, cape: null,
      });
      expect(Object.keys(profile.skins)).toHaveLength(1);
    }
    const none = buildPlayerProfile({ playerName: 'P', skin: null, cape: null });
    expect(Object.keys(none.skins)).toHaveLength(1);
  });

  it('值是裸哈希而不是 URL（客户端自己拼路径，这是 /textures/{hash} 必须存在的原因）', () => {
    const profile = buildPlayerProfile({
      playerName: 'P', skin: { hash: 'abc', model: 'default' }, cape: null,
    });
    expect(profile.skins.default).toBe('abc');
    expect(profile.skins.default).not.toMatch(/^https?:/);
  });

  it('没有签名、metadata、capes 数组（旧版就没有，别按 Mojang API 的预期加）', () => {
    const profile = buildPlayerProfile({
      playerName: 'P', skin: { hash: 'h', model: 'default' }, cape: { hash: 'c' },
    });
    expect(Object.keys(profile).sort()).toEqual(['cape', 'skins', 'username']);
  });

  it('中文玩家名不被转义（对应旧版的 JSON_UNESCAPED_UNICODE）', () => {
    const profile = buildPlayerProfile({
      playerName: '玩家名', skin: null, cape: null,
    });
    expect(serializePlayerProfile(profile)).toContain('玩家名');
    expect(serializePlayerProfile(profile)).not.toContain('\\u');
  });
});
