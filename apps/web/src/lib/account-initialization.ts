import { ApiError, initializationApi } from '@/api';
import { saveTokens } from '@/lib/token-store';

type InitializationInput = Parameters<typeof initializationApi.submit>[0];
type InitializationClient = Pick<typeof initializationApi, 'submit' | 'status'>;

function localDestination(value: string) {
  return /^\/(?!\/)[A-Za-z0-9/_?=&%+.,~-]*$/.test(value) && !value.startsWith('/auth/') ? value : '/user';
}

export async function submitAccountInitialization(input: InitializationInput, client: InitializationClient = initializationApi): Promise<string> {
  try {
    const result = await client.submit(input);
    // 初始化会轮换会话：保存响应携带的新令牌，随后的整页跳转由启动引导接管
    saveTokens(result.accessToken, result.refreshToken);
    return result.needsEmailVerification ? '/user' : localDestination(result.redirect);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'auth.already_initialized') return '/user';
    if (error instanceof ApiError && error.status < 500) throw error;
    try {
      const status = await client.status();
      if (!status.needsInitialization) return '/user';
    } catch {
      throw error;
    }
    throw error;
  }
}
