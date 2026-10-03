// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppDialog from '@/components/ui/AppDialog.vue';
import AppForm from '@/components/ui/AppForm.vue';

const { mockTexture } = vi.hoisted(() => ({
  mockTexture: {
    id: 42,
    hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    kind: 'skin',
    model: 'slim',
    name: 'Cyber Samurai',
    official: false,
    visibility: 'public',
    width: 64,
    height: 64,
    sizeBytes: 4096,
    likes: 88,
    uploaderId: 10,
    uploaderName: 'BlockSmith',
    sourceResourceId: null,
    origin: 'original',
    sourceResourceName: null,
    createdAt: 1710000000,
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({
    params: { tid: '42' },
    path: '/skinlib/42',
    fullPath: '/skinlib/42',
  }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    user: { value: { id: 10, role: 'user' } },
    isAdmin: { value: false },
    loaded: { value: true },
    fetchSession: vi.fn(),
  }),
}));

const siteSettings = ref({});
const siteLocale = ref('zh_CN');

vi.mock('@/stores/site', () => ({
  useSiteSettings: () => ({
    get: (key: string) => {
      if (key === 'comments_enabled') return 'true';
      if (key === 'allow_texture_download') return 'true';
      return '';
    },
    settings: siteSettings,
    fetch: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    locale: siteLocale,
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'general.skinlib': '皮肤库',
        'general.skin': '皮肤',
        'general.cape': '披风',
        'general.public': '公开',
        'general.private': '私密',
        'general.owner': '拥有者',
        'general.cancel': '取消',
        'general.back': '返回',
        'general.submit': '提交',
        'skinlib.show.title': '材质详情',
        'skinlib.show.uploader': '上传者',
        'skinlib.show.upload-at': '上传日期',
        'skinlib.show.likes': '收藏人数',
        'skinlib.show.download': '下载',
        'skinlib.show.name': '名称',
        'skinlib.show.delete-texture': '删除材质',
        'skinlib.show.manage-notice': '材质设为隐私或被删除后将会从每一个收藏者的衣柜中移除。',
        'skinlib.resolution': '分辨率',
        'skinlib.file_size': '文件大小',
        'skinlib.hash': '哈希值',
        'skinlib.apply': '应用到角色',
        'skinlib.addToCloset': '添加至衣柜',
        'skinlib.removeFromCloset': '从衣柜中移除',
        'skinlib.model_slim': 'Alex · 纤细',
        'skinlib.model_classic': 'Steve · 标准',
        'skinlib.description': '材质描述',
        'skinlib.description_edit': '编辑描述',
        'skinlib.description_empty': '暂无描述',
        'skinlib.report.title': '举报',
        'skinlib.report.reason': '请填写举报原因',
        'admin-panel.manage': '管理',
        'admin.role_admin': '管理员',
        'common.save': '保存',
        'common.copy': '复制',
        'common.copied': '已复制',
        'editor.edit': '在线编辑',
      };
      if (key === 'common.dimensions' && params) {
        return `${params.width} × ${params.height}`;
      }
      if (key === 'common.size_kb' && params) {
        return `${params.size} KB`;
      }
      if (key === 'comments.navigation' && params) {
        return `评论 (${params.count})`;
      }
      return messages[key] || key;
    },
    n: (num: number) => String(num),
    d: (timestamp: number) => new Date(timestamp * 1000).toISOString().split('T')[0],
  }),
}));

vi.mock('@/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super();
      this.status = status;
    }
  },
  textureApi: {
    get: vi.fn().mockResolvedValue(mockTexture),
    getDescription: vi.fn().mockResolvedValue({ description: 'Detailed futuristic armor texture.' }),
    putDescription: vi.fn().mockResolvedValue(undefined),
    patch: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  closetApi: {
    list: vi.fn().mockResolvedValue({ items: [{ textureId: 42 }] }),
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  reportApi: {
    submit: vi.fn().mockResolvedValue(undefined),
  },
  textureUrl: (hash: string) => `/textures/${hash}.png`,
  previewUrl: (hash: string) => `/preview/${hash}?render=3`,
}));

vi.mock('@/components/TexturePreviewer.vue', () => ({
  default: {
    props: ['skinUrl', 'capeUrl', 'slim', 'height', 'name'],
    template: '<div class="mock-texture-previewer">{{ name }}</div>',
  },
}));

vi.mock('@/components/TextureComments.vue', () => ({
  default: {
    props: ['textureId'],
    template: '<div class="mock-texture-comments">Comments</div>',
  },
}));

vi.mock('@/components/SkinlibLoading.vue', () => ({
  default: {
    template: '<div class="mock-loading">Loading...</div>',
  },
}));

vi.mock('@/components/ApplyTextureDialog.vue', () => ({
  default: {
    template: '<div class="mock-apply-dialog"></div>',
  },
}));

vi.mock('@/components/ui/MarkdownEditor.vue', () => ({
  default: {
    template: '<div class="mock-editor"></div>',
  },
}));

vi.mock('@/lib/seo', () => ({
  baseMetadata: vi.fn().mockReturnValue({ canonical: 'http://test' }),
  applyPageMetadata: vi.fn(),
}));

import SkinlibShow from '@/views/skinlib/Show.vue';

function createShowWrapper() {
  return mount(SkinlibShow, {
    global: {
      components: {
        AppButton,
        AppIcon,
        AppInput,
        AppSelect,
        AppDialog,
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

describe('Skinlib Show View', () => {
  it('renders texture title, badges, and action buttons', async () => {
    const wrapper = createShowWrapper();
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('Cyber Samurai');
    expect(text).toContain('Alex · 纤细');
    expect(text).toContain('公开');
    expect(text).toContain('应用到角色');
    expect(text).toContain('下载');
    expect(text).toContain('在线编辑');
  });

  it('renders author manage panel when user is owner', async () => {
    const wrapper = createShowWrapper();
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('管理');
    expect(text).toContain('拥有者');
    expect(text).toContain('保存');
  });

  it('renders SHA256 hash and copy trigger', async () => {
    const wrapper = createShowWrapper();
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(text).toContain('复制');
  });
});
