import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  guard: null as null | ((route: { path: string; fullPath: string; matched: Array<{ path: string; meta: { requiresAuth: boolean } }> }) => Promise<unknown>),
  session: {
    user: { value: null as null | { email: string; needsInitialization: boolean } },
    loaded: { value: true }, isAdmin: { value: false }, fetchSession: vi.fn(),
  },
}));
vi.mock('vue-router', () => ({
  createWebHistory: vi.fn(),
  createRouter: () => ({ beforeEach: (guard: typeof fixtures.guard) => { fixtures.guard = guard; } }),
}));
vi.mock('@/stores/session', () => ({ useSessionStore: () => fixtures.session }));
import '@/router/index';

const entry = { path: '/auth/initialize', fullPath: '/auth/initialize?redirect=/user/applications', matched: [{ path: '/auth/initialize', meta: { requiresAuth: true } }] };
beforeEach(() => {
  fixtures.session.user.value = null; fixtures.session.loaded.value = true; fixtures.session.isAdmin.value = false;
  fixtures.session.fetchSession.mockReset(); fixtures.session.fetchSession.mockResolvedValue(undefined);
});
describe('initialization route entry', () => {
  it('refreshes stale initialization state and sends a completed account to the user center', async () => {
    fixtures.session.user.value = { email: 'player@example.com', needsInitialization: true };
    fixtures.session.fetchSession.mockImplementation(async () => { fixtures.session.user.value!.needsInitialization = false; });
    expect(await fixtures.guard!(entry)).toEqual({ path: '/user', replace: true });
    expect(fixtures.session.fetchSession).toHaveBeenCalledWith(true);
  });
  it('allows an unfinished account to view setup', async () => {
    fixtures.session.user.value = { email: 'player@oauth.invalid', needsInitialization: true };
    expect(await fixtures.guard!(entry)).toBe(true);
  });
  it('requires login if the setup session is no longer valid', async () => {
    expect(await fixtures.guard!(entry)).toEqual({ path: '/login', query: { redirect: entry.fullPath } });
  });
  it('still redirects unfinished accounts away from private pages', async () => {
    fixtures.session.user.value = { email: 'player@oauth.invalid', needsInitialization: true };
    const route = { path: '/user/applications', fullPath: '/user/applications', matched: [{ path: '/user/applications', meta: { requiresAuth: true } }] };
    expect(await fixtures.guard!(route)).toEqual({ path: '/auth/initialize', query: { redirect: route.fullPath } });
  });
});
