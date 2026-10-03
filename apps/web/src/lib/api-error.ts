import { ApiError } from '@/api';
import { useI18n } from '@/stores/i18n';

/**
 * API 错误 → 用户文案的唯一入口。
 * ApiError 携带机器码，直接查词典；其余（网络中断、TypeError 等）回落网络错误文案。
 */
export function apiErrorMessage(error: unknown): string {
  const i18n = useI18n();
  return error instanceof ApiError ? i18n.t(error.code) : i18n.t('common.network');
}
