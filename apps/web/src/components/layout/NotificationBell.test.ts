// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import NotificationBell from './NotificationBell.vue';

const api = vi.hoisted(() => ({ summary: vi.fn(), list: vi.fn(), markAllRead: vi.fn(), markRead: vi.fn() }));
vi.mock('@/api', () => ({ notificationApi: api }));
vi.mock('@/stores/session', () => ({ useSessionStore: () => ({ user: { value: { id: 2 } } }) }));
vi.mock('@/stores/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, te: () => false, n: String, d: String }) }));
vi.mock('@vuetify/v0', async () => {
  const { defineComponent, h } = await import('vue');
  const block = defineComponent({ setup: (_props, { slots }) => () => h('div', slots.default?.()) });
  const button = defineComponent({ inheritAttrs: false, setup: (_props, { attrs, slots }) => () => h('button', attrs, slots.default?.()) });
  return { Popover: { Root: block, Content: block, Activator: button } };
});

const wrappers: VueWrapper[] = [];
function render() {
  const wrapper = mount(NotificationBell, { global: { stubs: { AppIcon: true, AppButton: true, AppDialog: true } } });
  wrappers.push(wrapper);
  return wrapper;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('navigator', { locks: undefined });
  localStorage.clear();
  api.summary.mockReset().mockResolvedValue({ unread: 2 });
  api.list.mockReset().mockResolvedValue({ items: [], unread: 2 });
});
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('通知轮询', () => {
  it('闲置只加载摘要，展开时才请求正文', async () => {
    const wrapper = render();
    await flushPromises();
    expect(api.summary).toHaveBeenCalledTimes(1);
    expect(api.list).not.toHaveBeenCalled();
    await wrapper.get('button[aria-label="notif.title"]').trigger('click');
    await flushPromises();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('隐藏页面停止轮询，重新可见恢复，卸载后停止', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const wrapper = render();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.summary).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(api.summary).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.summary).toHaveBeenCalledTimes(1);
  });

  it('多个页面同时挂载时共享锁与摘要，只发送一次请求', async () => {
    let locked = false;
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
      if (locked) return callback(null);
      locked = true;
      try { return await callback({}); } finally { locked = false; }
    } } });
    render(); render();
    await flushPromises();
    expect(api.summary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(api.summary).toHaveBeenCalledTimes(2);
    expect(api.list).not.toHaveBeenCalled();
  });
});
