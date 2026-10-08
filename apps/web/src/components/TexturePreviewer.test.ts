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

vi.mock('@/components/SkinViewer.vue', () => ({
  default: {
    name: 'SkinViewer',
    props: ['skinUrl', 'capeUrl', 'slim', 'height', 'name', 'active'],
    template: '<div class="mock-skin-viewer" />',
  },
}));

vi.mock('@/components/SkinPreview.vue', () => ({
  default: {
    name: 'SkinPreview',
    props: ['skinUrl', 'slim', 'cape', 'alt'],
    template: '<div class="mock-skin-preview" />',
  },
}));

import TexturePreviewer from '@/components/TexturePreviewer.vue';

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
});
