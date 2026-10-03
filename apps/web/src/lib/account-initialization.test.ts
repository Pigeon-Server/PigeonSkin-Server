import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AccountInitialization } from '@/api';
import { submitAccountInitialization } from '@/lib/account-initialization';

const input = { email: 'player@example.com', nickname: 'Player', password: 'setup-password-9', ticket: '00000000-0000-4000-8000-000000000001', redirect: '/user/applications' };
const state = (pending: boolean) => ({ needsInitialization: pending } as AccountInitialization);
describe('account initialization completion', () => {
  it('continues the original authorization after a confirmed save without another session request', async () => {
    const client = { submit: vi.fn().mockResolvedValue({ redirect: '/connect/authorize/request', needsEmailVerification: false }), status: vi.fn() };
    expect(await submitAccountInitialization(input, client)).toBe('/connect/authorize/request');
    expect(client.submit).toHaveBeenCalledOnce(); expect(client.status).not.toHaveBeenCalled();
  });
  it('sends completed accounts requiring email verification to the user center', async () => {
    const client = { submit: vi.fn().mockResolvedValue({ redirect: '/connect/device', needsEmailVerification: true }), status: vi.fn() };
    expect(await submitAccountInitialization(input, client)).toBe('/user');
  });
  it('recovers an already completed account instead of showing a submission error', async () => {
    const client = { submit: vi.fn().mockRejectedValue(new ApiError(409, { error: 'auth.already_initialized' })), status: vi.fn() };
    expect(await submitAccountInitialization(input, client)).toBe('/user');
    expect(client.submit).toHaveBeenCalledOnce();
  });
  it('recovers a committed save when the response is lost without resubmitting credentials', async () => {
    const client = { submit: vi.fn().mockRejectedValue(new TypeError('Response interrupted')), status: vi.fn().mockResolvedValue(state(false)) };
    expect(await submitAccountInitialization(input, client)).toBe('/user');
    expect(client.submit).toHaveBeenCalledOnce(); expect(client.status).toHaveBeenCalledOnce();
  });
  it('preserves validation and expired-form errors without treating them as completed', async () => {
    for (const code of ['auth.email_taken', 'auth.initialization_expired'] as const) {
      const error = new ApiError(409, { error: code });
      const client = { submit: vi.fn().mockRejectedValue(error), status: vi.fn() };
      await expect(submitAccountInitialization(input, client)).rejects.toBe(error);
      expect(client.status).not.toHaveBeenCalled();
    }
  });
  it('does not claim success when recovery still finds a pending account or cannot read it', async () => {
    const error = new TypeError('Response interrupted');
    for (const status of [vi.fn().mockResolvedValue(state(true)), vi.fn().mockRejectedValue(new Error('Unavailable'))]) {
      await expect(submitAccountInitialization(input, { submit: vi.fn().mockRejectedValue(error), status })).rejects.toBe(error);
    }
  });
  it('rejects an unsafe destination even in a successful response', async () => {
    const client = { submit: vi.fn().mockResolvedValue({ redirect: '//other.example', needsEmailVerification: false }), status: vi.fn() };
    expect(await submitAccountInitialization(input, client)).toBe('/user');
  });
});
