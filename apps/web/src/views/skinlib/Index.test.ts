import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import SkinlibIndex from '@/views/skinlib/Index.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppPagination from '@/components/ui/AppPagination.vue';
import EmptyState from '@/components/ui/EmptyState.vue';

const mockRoute = {
  query: {
    filter: 'skin',
    keyword: 'Knight',
    page: '1',
  },
  fullPath: '/skinlib?filter=skin&keyword=Knight',
};

const mockRouter = {
  push: vi.fn(),
  replace: vi.fn(),
};

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => mockRouter,
}));

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    user: { value: { id: 1, role: 'admin' } },
    loaded: { value: true },
    fetchSession: vi.fn(),
  }),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'general.skinlib': '皮肤库',
        'general.search': '搜索',
        'general.close': '关闭',
        'general.noResult': '没有匹配结果',
        'skinlib.upload.title': '上传材质',
        'skinlib.create.title': '在线制作',
        'skinlib.seeMyUpload': '我上传的',
        'skinlib.reset': '清除筛选',
        'skinlib.sort.title': '排序',
        'skinlib.sort.time': '最新上传',
        'skinlib.sort.likes': '最多收藏',
        'skinlib.texture_type': '材质类型',
        'common.all': '全部',
        'skinlib.filter.skin': '皮肤',
        'skinlib.filter.steve': 'Steve · 标准',
        'skinlib.filter.alex': 'Alex · 纤细',
        'skinlib.filter.cape': '披风',
        'skinlib.filter.official': 'Mojang 官方',
        'common.prev': '上一页',
        'common.next': '下一页',
      };
      if (key === 'common.count' && params) {
        return `共 ${params.count} 件`;
      }
      return messages[key] || key;
    },
    n: (num: number) => String(num),
  }),
}));

vi.mock('@/api', () => ({
  textureApi: {
    list: vi.fn().mockResolvedValue({
      items: [
        {
          id: 1,
          hash: 'skin-hash-1',
          kind: 'skin',
          model: 'default',
          name: 'Hero Steve',
          official: false,
          visibility: 'public',
          width: 64,
          height: 64,
          sizeBytes: 1024,
          likes: 12,
          uploaderId: 1,
          uploaderName: 'Admin',
          sourceResourceId: null,
          origin: 'original',
          sourceResourceName: null,
          createdAt: 1700000000,
        },
      ],
      total: 1,
      totalPages: 1,
      page: 1,
      perPage: 24,
    }),
  },
  closetApi: {
    list: vi.fn().mockResolvedValue({
      items: [],
      hasMore: false,
      page: 1,
    }),
    add: vi.fn().mockResolvedValue({ ok: true, scoreSpent: 0 }),
    remove: vi.fn().mockResolvedValue(undefined),
  },
  previewUrl: (hash: string) => `/preview/${hash}?render=3`,
}));

function createIndexApp() {
  const app = createSSRApp({
    render: () => h(SkinlibIndex),
  });
  app.component('AppButton', AppButton);
  app.component('AppIcon', AppIcon);
  app.component('AppInput', AppInput);
  app.component('AppPagination', AppPagination);
  app.component('EmptyState', EmptyState);
  app.component('router-link', {
    props: ['to'],
    template: '<a :href="to"><slot /></a>',
  });
  return app;
}

describe('Skinlib Index View', () => {
  it('renders heading, actions, and filter tabs', async () => {
    const html = await renderToString(createIndexApp());
    expect(html).toContain('皮肤库');
    expect(html).toContain('上传材质');
    expect(html).toContain('在线制作');
    expect(html).toContain('最新上传');
    expect(html).toContain('最多收藏');
    expect(html).toContain('我上传的');
  });

  it('renders search input with current query keyword', async () => {
    const html = await renderToString(createIndexApp());
    expect(html).toContain('value="Knight"');
  });
});
