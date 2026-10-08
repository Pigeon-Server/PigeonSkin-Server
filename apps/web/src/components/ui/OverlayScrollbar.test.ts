// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OverlayScrollbar from '@/components/ui/OverlayScrollbar.vue';

const callbacks: Array<() => void> = [];
const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
vi.stubGlobal('ResizeObserver', class {
  disconnect = vi.fn();
  observe = vi.fn();
  constructor(callback: () => void) {
    callbacks.push(callback);
    observers.push(this);
  }
});

const wrappers: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
  callbacks.length = 0;
  observers.length = 0;
});

async function setup() {
  const target = document.createElement('div');
  target.id = 'home-scroll';
  Object.defineProperties(target, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1000 },
  });
  document.body.append(target);
  const wrapper = mount(OverlayScrollbar, { props: { target, label: '首页' }, attachTo: document.body });
  wrappers.push(wrapper);
  Object.defineProperties(wrapper.element, {
    clientHeight: { configurable: true, value: 196 },
    setPointerCapture: { value: vi.fn() },
  });
  callbacks.forEach(callback => callback());
  await nextTick();
  return { target, wrapper };
}

async function pointer(element: Element, type: string, clientY: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  element.dispatchEvent(event);
  await nextTick();
}

describe('OverlayScrollbar', () => {
  it('tracks native scrolling and exposes the current position', async () => {
    const { target, wrapper } = await setup();
    expect(wrapper.attributes('aria-controls')).toBe('home-scroll');
    target.scrollTop = 400;
    target.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(wrapper.attributes('aria-valuenow')).toBe('50');
    expect(wrapper.find('.overlay-scrollbar-thumb').attributes('style')).toContain('translateY(78.4px)');
  });

  it('supports keyboard bounds and page-sized scrolling', async () => {
    const { target, wrapper } = await setup();
    await wrapper.trigger('keydown', { key: 'PageDown' });
    expect(target.scrollTop).toBe(200);
    await wrapper.trigger('keydown', { key: 'End' });
    expect(target.scrollTop).toBe(800);
    await wrapper.trigger('keydown', { key: 'ArrowDown' });
    expect(target.scrollTop).toBe(800);
    await wrapper.trigger('keydown', { key: 'Home' });
    await wrapper.trigger('keydown', { key: 'ArrowUp' });
    expect(target.scrollTop).toBe(0);
  });

  it('supports thumb dragging, track clicks and pointer cancellation', async () => {
    const { target, wrapper } = await setup();
    await pointer(wrapper.element, 'pointerdown', 10);
    expect(target.scrollTop).toBe(0);
    await pointer(wrapper.element, 'pointermove', 88.4);
    expect(target.scrollTop).toBeCloseTo(400);
    await pointer(wrapper.element, 'pointercancel', 88.4);
    await pointer(wrapper.element, 'pointermove', 196);
    expect(target.scrollTop).toBeCloseTo(400);
    await pointer(wrapper.element, 'pointerdown', 196, 2);
    expect(target.scrollTop).toBe(800);
  });

  it('forwards wheel events on the overlay and hides when content fits', async () => {
    const { target, wrapper } = await setup();
    await wrapper.trigger('wheel', { deltaY: 2, deltaMode: 1 });
    expect(target.scrollTop).toBe(32);
    Object.defineProperty(target, 'scrollHeight', { configurable: true, value: 200 });
    target.scrollTop = 0;
    callbacks.forEach(callback => callback());
    await nextTick();
    expect(wrapper.attributes('style')).toContain('display: none');
    Object.defineProperty(target, 'scrollHeight', { configurable: true, value: 1000 });
    callbacks.forEach(callback => callback());
    await nextTick();
    expect(wrapper.attributes('style') ?? '').not.toContain('display: none');
    const remove = vi.spyOn(target, 'removeEventListener');
    wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true);
  });

  it('rebinds to a replacement scroll target and clamps overscroll positions', async () => {
    const { target, wrapper } = await setup();
    const replacement = document.createElement('div');
    replacement.id = 'replacement-scroll';
    Object.defineProperties(replacement, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 600 },
    });
    replacement.scrollTop = 100;
    const remove = vi.spyOn(target, 'removeEventListener');
    await wrapper.setProps({ target: replacement });
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(wrapper.attributes('aria-controls')).toBe('replacement-scroll');
    expect(wrapper.attributes('aria-valuenow')).toBe('25');
    replacement.scrollTop = -20;
    replacement.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(wrapper.attributes('aria-valuenow')).toBe('0');
    replacement.scrollTop = 500;
    replacement.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(wrapper.attributes('aria-valuenow')).toBe('100');
  });
});
