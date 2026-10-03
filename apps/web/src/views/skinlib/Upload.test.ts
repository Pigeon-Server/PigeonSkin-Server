// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import SkinlibUpload from '@/views/skinlib/Upload.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppForm from '@/components/ui/AppForm.vue';

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
  useRoute: () => ({
    query: {},
  }),
}));

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    user: { value: { id: 1 } },
    fetchSession: vi.fn(),
  }),
}));

vi.mock('@/stores/site', () => ({
  useSiteSettings: () => ({
    get: (key: string) => {
      if (key === 'max_upload_size_kb') return '1024';
      if (key === 'max_texture_width') return '8192';
      return '';
    },
    fetch: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'general.skinlib': '皮肤库',
        'general.skin': '皮肤',
        'general.cape': '披风',
        'general.public': '公开',
        'general.private': '私密',
        'skinlib.upload.title': '上传材质',
        'skinlib.upload.select-file': '选择文件',
        'skinlib.upload.texture-name': '材质名称',
        'skinlib.upload.button': '确认上传',
        'skinlib.texture_type': '材质类型',
        'skinlib.show.model': '适用模型',
        'skinlib.model_classic': 'Steve · 标准',
        'skinlib.model_slim': 'Alex · 纤细',
        'skinlib.origin': '材质来源',
        'skinlib.origin_original': '原创',
        'skinlib.origin_repost': '转载',
        'skinlib.description': '材质描述',
        'common.visibility': '可见性',
      };
      if (key === 'skinlib.upload_limits' && params) {
        return `小于 ${params.size} KB`;
      }
      if (key === 'skinlib.upload_cost' && params) {
        return `消耗约 ${params.score} 积分`;
      }
      return messages[key] || key;
    },
    n: (num: number) => String(num),
  }),
}));

vi.mock('@/components/TexturePreviewer.vue', () => ({
  default: {
    template: '<div class="mock-texture-previewer"></div>',
  },
}));

vi.mock('@/components/ui/MarkdownEditor.vue', () => ({
  default: {
    template: '<div class="mock-markdown-editor"></div>',
  },
}));

function createUploadWrapper() {
  return mount(SkinlibUpload, {
    global: {
      components: {
        AppButton,
        AppIcon,
        AppInput,
        AppSelect,
        AppForm,
        MarkdownContent: {
          props: ['content'],
          template: '<div class="mock-markdown-content">{{ content }}</div>',
        },
        'router-link': {
          props: ['to'],
          template: '<a :href="to"><slot /></a>',
        },
      },
    },
  });
}

describe('Skinlib Upload View', () => {
  it('renders upload dropzone and fields', () => {
    const wrapper = createUploadWrapper();
    const text = wrapper.text();
    expect(text).toContain('上传材质');
    expect(text).toContain('选择文件');
    expect(text).toContain('材质名称');
    expect(text).toContain('确认上传');
  });
});
