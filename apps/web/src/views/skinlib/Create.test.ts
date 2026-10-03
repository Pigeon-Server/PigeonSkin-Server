// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import SkinlibCreate from '@/views/skinlib/Create.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppForm from '@/components/ui/AppForm.vue';

const mockPush = vi.fn();

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        'general.skinlib': '皮肤库',
        'general.skin': '皮肤',
        'general.cape': '披风',
        'skinlib.create.title': '创作材质',
        'skinlib.create.description': '选择皮肤或披风并进入编辑器创作',
        'skinlib.create.start': '开始创作',
        'skinlib.upload.texture-name': '材质名称',
        'skinlib.texture_type': '材质类型',
        'skinlib.show.model': '适用模型',
        'skinlib.model_classic': 'Steve · 标准',
        'skinlib.model_slim': 'Alex · 纤细',
        'skinlib.preview_label': '材质预览',
      };
      return messages[key] || key;
    },
    n: (num: number) => String(num),
  }),
}));

vi.mock('@/components/SkinPreview.vue', () => ({
  default: {
    props: ['skinUrl', 'slim', 'cape', 'alt'],
    template: '<div class="mock-skin-preview">{{ alt }}</div>',
  },
}));

function createWrapper() {
  return mount(SkinlibCreate, {
    global: {
      components: {
        AppButton,
        AppIcon,
        AppInput,
        AppForm,
        'router-link': {
          props: ['to'],
          template: '<a :href="to"><slot /></a>',
        },
      },
    },
  });
}

describe('Skinlib Create View', () => {
  it('renders title, templates, and options', () => {
    const wrapper = createWrapper();
    const text = wrapper.text();
    expect(text).toContain('创作材质');
    expect(text).toContain('Steve · 标准');
    expect(text).toContain('开始创作');
  });

  it('triggers router push to editor when starting creation', async () => {
    const wrapper = createWrapper();
    await wrapper.findComponent(AppForm).vm.$emit('submit', { valid: true, preventDefault: () => {} } as any);
    expect(mockPush).toHaveBeenCalledWith({
      path: '/editor/skin',
      query: { blank: '1', model: 'default' },
    });
  });
});
