import { describe, expect, it } from 'vitest';
import { isD1QuotaError } from '../src/core/usage-budget.ts';

// D1 日额度耗尽的判定是整套「配额错误不推进游标 / 不计业务失败」设计的基础。
// 平台实际返回的形态并不统一：有的带结构化错误码 7500，有的是纯文案，
// 还有的包在 cause 链里 —— 漏判会让后台任务把额度故障当成业务失败，
// 5 分钟就能把任务永久判失败。
describe('isD1QuotaError', () => {
  it('识别结构化错误码 7500', () => {
    expect(isD1QuotaError({ code: 7500, message: 'something went wrong' })).toBe(true);
    expect(isD1QuotaError({ code: '7500', message: '' })).toBe(true);
  });

  it('识别嵌在 cause 链里的 7500', () => {
    expect(isD1QuotaError(new Error('upstream failed', { cause: { code: 7500 } }))).toBe(true);
  });

  it('识别平台常见文案', () => {
    expect(isD1QuotaError(new Error("Your account has exceeded D1's free tier daily row read limit."))).toBe(true);
    expect(isD1QuotaError(new Error('Exceeded maximum allowed rows read per day'))).toBe(true);
    expect(isD1QuotaError(new Error('D1_ERROR: daily row write limit reached'))).toBe(true);
  });

  it('普通业务错误不误判', () => {
    expect(isD1QuotaError(new Error('UNIQUE constraint failed: textures.hash'))).toBe(false);
    expect(isD1QuotaError(new Error('no such table: textures'))).toBe(false);
    expect(isD1QuotaError(null)).toBe(false);
    expect(isD1QuotaError(undefined)).toBe(false);
  });
});
