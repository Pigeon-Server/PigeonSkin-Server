// runCeremony 看门狗契约：平台弹框没出来时仪式 Promise 会无限挂起，
// 看门狗必须兜底中止并 reject 成取消语义（securityError → security.cancelled）。
// securityError 本身按 Error.name 映射，WebAuthnError（普通 Error，name 保留）
// 与原生 DOMException 走同一分支。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cancelSpy = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  WebAuthnAbortService: { cancelCeremony: () => cancelSpy() },
}));
const { runCeremony, securityError, cancelPasskeyCeremony } = await import('@/lib/security');

beforeEach(() => { cancelSpy.mockClear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('runCeremony 看门狗', () => {
  it('仪式先落地：原样返回，计时器清理，不中止', async () => {
    let resolve!: (value: string) => void;
    const promise = runCeremony(() => new Promise<string>(r => { resolve = r; }), 120_000);
    resolve('ok');
    await expect(promise).resolves.toBe('ok');
    vi.advanceTimersByTime(121_000);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('仪式挂起：到点中止并 reject 成 AbortError（映射到 security.cancelled）', async () => {
    const promise = runCeremony(() => new Promise<string>(() => {}), 120_000);
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    const rejected: unknown = await promise.catch(e => e);
    expect(securityError(rejected)).toBe('security.cancelled');
  });

  it('仪式在超时前 reject：错误原样透传，不中止', async () => {
    const boom = new DOMException('denied', 'NotAllowedError');
    await expect(runCeremony(async () => { throw boom; }, 120_000)).rejects.toBe(boom);
    vi.advanceTimersByTime(121_000);
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

describe('cancelPasskeyCeremony 委托', () => {
  it('调用 WebAuthnAbortService.cancelCeremony', () => {
    cancelPasskeyCeremony();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});

describe('securityError 错误名映射', () => {
  it('WebAuthnError 形态（普通 Error，name 保留 AbortError）映射到取消文案', () => {
    const err = new Error('Registration ceremony was sent an abort signal');
    err.name = 'AbortError';
    expect(securityError(err)).toBe('security.cancelled');
  });
  it('原生 NotAllowedError（DOMException）同样映射到取消文案', () => {
    expect(securityError(new DOMException('denied', 'NotAllowedError'))).toBe('security.cancelled');
  });
});
