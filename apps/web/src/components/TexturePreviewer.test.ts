// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import AppButton from '@/components/ui/AppButton.vue';

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    locale: { value: 'zh_CN' },
    t: (key: string) => key,
    n: (num: number) => String(num),
    d: () => '',
  }),
}));

vi.mock('@/components/texture/SkinViewer.vue', () => ({
  default: {
    name: 'SkinViewer',
    props: ['skinUrl', 'capeUrl', 'slim', 'height', 'name', 'active'],
    template: '<div class="mock-skin-viewer" />',
  },
}));

vi.mock('@/components/texture/SkinPreview.vue', () => ({
  default: {
    name: 'SkinPreview',
    props: ['skinUrl', 'slim', 'cape', 'alt'],
    template: '<div class="mock-skin-preview" />',
  },
}));

import TexturePreviewer from '@/components/texture/TexturePreviewer.vue';

function mountPreviewer() {
  return mount(TexturePreviewer, {
    props: { skinUrl: '/textures/abc', capeUrl: null },
    global: { components: { AppButton } },
  });
}

describe('TexturePreviewer', () => {
  it('offers only 3D and 2D previews', async () => {
    const wrapper = mountPreviewer();
    const tabs = wrapper.findAll('.filter-tabs button');
    expect(tabs.map(tab => tab.text())).toEqual(['skinlib.preview_3d', 'skinlib.preview_2d']);
    expect(wrapper.text()).not.toContain('skinlib.raw');
  });

  it('renders the 2D preview for the selected texture', async () => {
    const wrapper = mountPreviewer();
    expect(wrapper.find('.mock-skin-preview').exists()).toBe(false);
    await wrapper.findAll('.filter-tabs button')[1]!.trigger('click');
    expect(wrapper.find('.mock-skin-preview').exists()).toBe(true);
  });

  // 回归防护：slim 是可选 prop，缺省必须是 undefined 而不是 false。
  // Vue 把无 default 的 Boolean prop cast 成 false 时，自动化识别分支会变成死代码，
  // 预览永远按经典模型渲染（曾被真实踩中）。
  it('passes slim through as undefined when the caller omits it', () => {
    const wrapper = mountPreviewer();
    const viewer = wrapper.findComponent({ name: 'SkinViewer' });
    expect(viewer.props('slim')).toBeUndefined();
  });

  it('still forwards an explicit slim value', () => {
    const wrapper = mount(TexturePreviewer, {
      props: { skinUrl: '/textures/abc', capeUrl: null, slim: true },
      global: { components: { AppButton } },
    });
    const viewer = wrapper.findComponent({ name: 'SkinViewer' });
    expect(viewer.props('slim')).toBe(true);
  });
});
