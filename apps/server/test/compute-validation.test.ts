import { env } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { DEFAULT_TEXTURE_LIMITS } from '@pigeon-skin/minecraft';
import { makePng } from '../../../packages/minecraft/test/png-builder.ts';
import type { Bindings } from '../src/core/env.ts';
import { computeValidateTexture } from '../src/services/compute.ts';
import { adminImportTexture } from '../src/services/admin-import.ts';
import { runMigrations } from './setup.ts';

beforeAll(runMigrations);

it('计算 DO 与无绑定回退对有效、CRC、尺寸和类型校验结果一致', async () => {
  const source = env as Bindings;
  const local = { DB: source.DB };
  const png = makePng({ width: 64, height: 64 });
  const cases = [
    { bytes: png, target: { kind: 'skin' as const, model: 'default' as const }, limits: DEFAULT_TEXTURE_LIMITS },
    { bytes: makePng({ width: 64, height: 64, corruptIdatCrc: true }), target: { kind: 'skin' as const, model: 'default' as const }, limits: DEFAULT_TEXTURE_LIMITS },
    { bytes: png, target: { kind: 'skin' as const, model: 'default' as const }, limits: { ...DEFAULT_TEXTURE_LIMITS, maxSizeBytes: 1 } },
    { bytes: png, target: { kind: 'cape' as const, model: null }, limits: DEFAULT_TEXTURE_LIMITS },
  ];
  for (const item of cases) expect(await computeValidateTexture(source, item.bytes, item.target, item.limits)).toEqual(await computeValidateTexture(local, item.bytes, item.target, item.limits));
});

it('管理员导入通过计算 DO 校验并保存材质，损坏文件被拒绝', async () => {
  const input = { kind: 'skin' as const, name: 'import-test', visibility: 'public' as const, origin: 'original' as const, uploaderId: null };
  const result = await adminImportTexture(env as Bindings, { ...input, bytes: makePng({ width: 64, height: 64 }) });
  expect(result.width).toBe(64);
  const object = await env.BUCKET.get(`textures/${result.hash}.png`);
  expect(object).not.toBeNull();
  await object!.arrayBuffer();
  // 模型由导入路径自己解码判定(不依赖 form 参数)
  const row = await env.DB.prepare('SELECT model FROM textures WHERE id = ?').bind(result.id).first<{ model: string }>();
  expect(row?.model).toBe('default');
  await expect(adminImportTexture(env as Bindings, { ...input, bytes: makePng({ width: 64, height: 64, corruptIdatCrc: true }) })).rejects.toMatchObject({ status: 422 });
});

it('管理员导入的 slim 模板皮肤被识别为 slim', async () => {
  const result = await adminImportTexture(env as Bindings, {
    bytes: makePng({ width: 64, height: 64, slim: true }),
    kind: 'skin', name: 'import-slim', visibility: 'public', origin: 'original', uploaderId: null,
  });
  const row = await env.DB.prepare('SELECT model FROM textures WHERE id = ?').bind(result.id).first<{ model: string }>();
  expect(row?.model).toBe('slim');
});
