import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { ApiError } from '@/api';

export function passkeysSupported() {
  return location.protocol === 'https:' && window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
}
export function securityError(error: unknown) {
  if (error instanceof ApiError) return error.code;
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'security.cancelled';
  return 'common.network';
}

/**
 * 中止进行中的 passkey 仪式（浏览器弹框 / 设备等待）。
 * @simplewebauthn/browser 对每次 create/get 注入该单例的 signal，
 * 重复调用幂等，未在进行中时是空操作。
 */
export function cancelPasskeyCeremony() {
  WebAuthnAbortService.cancelCeremony();
}

/**
 * 看门狗包裹一次 passkey 仪式：平台超时（60s）只在 OS 弹框真正
 * 弹出后才计时，弹框没出来时仪式 Promise 会无限挂起 —— 这里再兜
 * 一层硬超时，超时即中止并 reject 成取消语义（securityError 映射到
 * security.cancelled）。
 */
export async function runCeremony<T>(action: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { cancelPasskeyCeremony(); const err = new Error('passkey ceremony timed out'); err.name = 'AbortError'; reject(err); }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
