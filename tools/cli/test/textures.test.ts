// CLI 导入计划的 hash 不变量。
//
// 对象键由 hash 推导（textures/<hash>.png），所以写入 R2 的字节必须就是
// 算出这个 hash 的那份 —— 即「净化后」的字节，不是磁盘上的原始文件。
// 这个测试锁住该不变量：带元数据的原始 PNG 与净化后字节的 hash 不同，
// 而返回的 bytes/hash 必须自洽，且与服务端 uploadTexture 的口径一致。
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@pigeon-skin/minecraft';
import { prepareImportItem } from '../src/commands/textures.ts';
import { makePng } from '../../../packages/minecraft/test/png-builder.ts';

describe('prepareImportItem', () => {
  it('a byte-for-byte hash of the returned bytes', async () => {
    const original = makePng({ width: 64, height: 64 });
    const prepared = await prepareImportItem(original, 'skin');
    expect('item' in prepared).toBe(true);
    if (!('item' in prepared)) return;
    // 核心不变量：hash 必须等于返回字节的 sha256（R2 键与内容同源）
    expect(prepared.item.hash).toBe(await sha256Hex(prepared.item.bytes));
  });

  it('strips metadata, so the imported hash differs from the raw file hash', async () => {
    const original = makePng({
      width: 64,
      height: 64,
      extraChunks: [{ type: 'tEXt', data: new TextEncoder().encode('Author\0someone') }],
    });
    const rawHash = await sha256Hex(original);
    const prepared = await prepareImportItem(original, 'skin');
    if (!('item' in prepared)) throw new Error(prepared.reason);
    // 原始文件带 tEXt，净化后字节不同 → hash 必须随之不同
    expect(prepared.item.hash).not.toBe(rawHash);
    expect(prepared.item.hash).toBe(await sha256Hex(prepared.item.bytes));
  });

  it('pads legacy 22×17 capes, so width/height reflect the stored size', async () => {
    const original = makePng({ width: 22, height: 17 });
    const prepared = await prepareImportItem(original, 'cape');
    if (!('item' in prepared)) throw new Error(prepared.reason);
    expect([prepared.item.width, prepared.item.height]).toEqual([64, 32]);
    expect(prepared.item.model).toBeNull();
  });

  it('detects the model from pixels (not from any caller argument)', async () => {
    const classic = await prepareImportItem(makePng({ width: 64, height: 64 }), 'skin');
    if (!('item' in classic)) throw new Error(classic.reason);
    expect(classic.item.model).toBe('default');

    const slim = await prepareImportItem(makePng({ width: 64, height: 64, slim: true }), 'skin');
    if (!('item' in slim)) throw new Error(slim.reason);
    expect(slim.item.model).toBe('slim');
  });

  it('rejects invalid input with a reason', async () => {
    const broken = await prepareImportItem(makePng({ width: 64, height: 64, corruptIdatCrc: true }), 'skin');
    expect('reason' in broken).toBe(true);
  });
});
