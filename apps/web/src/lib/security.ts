import { ApiError } from '@/api';

export function passkeysSupported() {
  return location.protocol === 'https:' && window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
}
export function securityError(error: unknown) {
  if (error instanceof ApiError) return error.code;
  if (error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) return 'security.cancelled';
  return 'common.network';
}
