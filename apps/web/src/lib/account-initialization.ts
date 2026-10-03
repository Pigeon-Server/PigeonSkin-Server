import { ApiError, initializationApi } from '@/api';

type InitializationInput = Parameters<typeof initializationApi.submit>[0];
type InitializationClient = Pick<typeof initializationApi, 'submit' | 'status'>;

function localDestination(value: string) {
  return /^\/(?!\/)[A-Za-z0-9/_?=&%+.,~-]*$/.test(value) && !value.startsWith('/auth/') ? value : '/user';
}

export async function submitAccountInitialization(input: InitializationInput, client: InitializationClient = initializationApi): Promise<string> {
  try {
    const result = await client.submit(input);
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
