// @vitest-environment jsdom
import { createSSRApp, h, reactive, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SkinlibIndex from '@/views/skinlib/Index.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { textureApi, type Paged, type TextureSummary } from '@/api';
import { skinlibCache } from '@/lib/skinlib-cache';

const state = vi.hoisted(() => ({
  route: {} as { query: Record<string, string>; fullPath: string },
  router: {} as {
    push: (location: { query?: Record<string, string> }) => void;
    replace: (location: { query?: Record<string, string> }) => void;
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => state.route,
  useRouter: () => state.router,
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
        'skinlib.load_more': '加载更多',
        'skinlib.loading_more': '正在加载更多材质…',
        'skinlib.loaded_all': '已显示全部材质',
        'skinlib.filter.skin': '皮肤',
        'skinlib.filter.steve': 'Steve · 标准',
        'skinlib.filter.alex': 'Alex · 纤细',
        'skinlib.filter.cape': '披风',
        'skinlib.filter.official': 'Mojang 官方',
        'skinlib.filter.allUsers': '全部用户',
        'common.all': '全部',
        'common.loading': '加载中',
        'common.retry': '重试',
        'common.network': '网络错误',
        'common.prev': '上一页',
        'common.next': '下一页',
      };
      if (key === 'common.count' && params) return `共 ${params.count} 件`;
      if (key === 'skinlib.filter.uploader' && params) return `上传者 UID ${params.uid}`;
      return messages[key] || key;
    },
    n: (num: number) => String(num),
    locale: ref('zh_CN'),
  }),
}));

vi.mock('@/components/TextureCard.vue', () => ({
  default: {
    props: ['texture'],
    template: '<article class="mock-texture-card" :data-id="texture.id">{{ texture.name }}</article>',
  },
}));

vi.mock('@/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    textureApi: { list: vi.fn() },
    closetApi: {
      list: vi.fn().mockResolvedValue({ items: [], hasMore: false, page: 1 }),
      add: vi.fn().mockResolvedValue({ ok: true, scoreSpent: 0 }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    previewUrl: (hash: string) => `/preview/${hash}?render=3`,
  };
});

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  emit(isIntersecting = true) {
    this.callback(
      [{ isIntersecting } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const PER_PAGE = 2;

function textureSummary(id: number): TextureSummary {
  return {
    id,
    hash: `skin-hash-${id}`,
    kind: 'skin',
    model: 'default',
    name: `材质 ${id}`,
    official: false,
    visibility: 'public',
    width: 64,
    height: 64,
    sizeBytes: 1024,
    likes: 0,
    uploaderId: 1,
    uploaderName: 'Admin',
    sourceResourceId: null,
    origin: 'original',
    sourceResourceName: null,
    createdAt: 1700000000,
  };
}

function pagePayload(page: number, totalPages: number): Paged<TextureSummary> {
  return {
    items: Array.from({ length: PER_PAGE }, (_, index) => textureSummary((page - 1) * PER_PAGE + index + 1)),
    total: totalPages * PER_PAGE,
    totalPages,
    page,
    perPage: PER_PAGE,
  };
}

function createIndexApp() {
  const app = createSSRApp({
    render: () => h(SkinlibIndex),
  });
  app.component('AppButton', AppButton);
  app.component('AppIcon', AppIcon);
  app.component('AppInput', AppInput);
  app.component('EmptyState', EmptyState);
  app.component('router-link', {
    props: ['to'],
    template: '<a :href="to"><slot /></a>',
  });
  return app;
}

function mountIndex() {
  return mount(SkinlibIndex, {
    global: {
      components: {
        AppButton,
        AppIcon,
        AppInput,
        EmptyState,
        'router-link': {
          props: ['to'],
          template: '<a :href="to"><slot /></a>',
        },
      },
    },
  });
}

async function settle() {
  await flushPromises();
  await flushPromises();
}

const listMock = vi.mocked(textureApi.list);

describe('Skinlib Index View', () => {
  beforeEach(() => {
    skinlibCache.clear();
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    window.scrollTo = vi.fn();
    state.route = reactive({
      query: { filter: 'skin', keyword: 'Knight', page: '1' },
      fullPath: '/skinlib?filter=skin&keyword=Knight',
    });
    state.router = {
      push: vi.fn((location: { query?: Record<string, string> }) => {
        state.route.query = location.query ?? {};
      }),
      replace: vi.fn((location: { query?: Record<string, string> }) => {
        state.route.query = location.query ?? {};
      }),
    };
    listMock.mockReset();
    listMock.mockImplementation(async (params) => pagePayload(params?.page ?? 1, 2));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('stacks the toolbar as two full-width rows with the filter cluster in the first row', async () => {
    const wrapper = mountIndex();
    await settle();

    const toolbar = wrapper.find('.resource-toolbar--stack');
    const rows = toolbar.findAll(':scope > .toolbar-row');
    expect(rows).toHaveLength(2);

    const [actionsRow, categoryRow] = rows;
    expect(actionsRow!.find('.search-field').exists()).toBe(true);
    expect(actionsRow!.find('.toolbar-actions').exists()).toBe(true);
    expect(categoryRow!.find('.toolbar-actions').exists()).toBe(false);

    const actions = actionsRow!.find('.toolbar-actions');
    expect(actions.find('.filter-tabs').exists()).toBe(true);
    expect(actions.find('button[aria-label="清除筛选"]').exists()).toBe(true);

    const categories = categoryRow!.find('[role="group"]');
    expect(categories.attributes('aria-label')).toBe('材质类型');
    expect(categories.findAll('button')).toHaveLength(6);
  });

  it('renders "我上传的" as a toggle pill and keeps the search clear button inline', async () => {
    const wrapper = mountIndex();
    await settle();

    const mineToggle = wrapper
      .findAll('.toolbar-actions .filter-tabs button')
      .find((button) => button.text().includes('我上传的'));
    expect(mineToggle).toBeTruthy();
    expect(mineToggle!.attributes('aria-pressed')).toBe('false');

    expect(wrapper.find('.search-field__clear').exists()).toBe(true);
    await wrapper.find('.search-field input').setValue('');
    expect(wrapper.find('.search-field__clear').exists()).toBe(false);
  });

  it('keeps padding utilities off the input wrapper so the field border stays continuous', async () => {
    const wrapper = mountIndex();
    await settle();

    // AppInput 会把 class 透传到外层 wrapper；padding 类落在 wrapper 上会挤窄输入框，
    // 使输入框右边框与提交按钮之间露出空隙。右内边距由 .search-field__input 规则承担。
    const inputWrapper = wrapper.find('.search-field__control').element.firstElementChild!;
    expect(inputWrapper.className).not.toMatch(/(?:^|\s)(?:[\w-]+:)*!?p[xytrbl]?-/);
    expect(wrapper.find('input.search-field__input').exists()).toBe(true);
  });

  it('keeps the uploader banner outside the toolbar rows', async () => {
    state.route.query = { uploader: '2' };
    const wrapper = mountIndex();
    await settle();

    const toolbar = wrapper.find('.resource-toolbar--stack');
    const banner = toolbar
      .findAll(':scope > *')
      .find((child) => child.text().includes('UID'));
    expect(banner).toBeTruthy();
    expect(banner!.classes()).not.toContain('toolbar-row');
    expect(banner!.find('button').exists()).toBe(true);
  });

  it('uses a scroll sentinel instead of a pagination bar', async () => {
    const wrapper = mountIndex();
    await settle();

    expect(wrapper.find('nav.pagination').exists()).toBe(false);
    expect(wrapper.findAll('.mock-texture-card')).toHaveLength(PER_PAGE);
    expect(wrapper.text()).toContain('加载更多');
  });

  it('loads the next page when the sentinel enters the viewport and syncs the page into the URL', async () => {
    const wrapper = mountIndex();
    await settle();

    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    const observer = FakeIntersectionObserver.instances[0]!;
    const [sentinel] = [...observer.targets];
    expect(sentinel?.textContent).toContain('加载更多');

    observer.emit();
    await settle();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, perPage: 24 }), {});
    expect(wrapper.findAll('.mock-texture-card')).toHaveLength(PER_PAGE * 2);
    expect(state.router.replace).toHaveBeenCalledWith({ query: expect.objectContaining({ page: '2' }) });
    expect(wrapper.text()).toContain('已显示全部材质');
  });

  it('keeps the loaded list when the URL only reflects the page already loaded', async () => {
    const wrapper = mountIndex();
    await settle();

    FakeIntersectionObserver.instances[0]!.emit();
    await settle();
    expect(listMock).toHaveBeenCalledTimes(2);

    // 缓存过期后，滚动加载写回的 ?page= 不应触发整列表重新拉取
    skinlibCache.clear();
    state.route.query = { filter: 'skin', keyword: 'Knight', page: '2' };
    await settle();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('.mock-texture-card')).toHaveLength(PER_PAGE * 2);
  });

  it('reloads when the URL page really changes', async () => {
    const wrapper = mountIndex();
    await settle();

    FakeIntersectionObserver.instances[0]!.emit();
    await settle();
    expect(wrapper.findAll('.mock-texture-card')).toHaveLength(PER_PAGE * 2);

    skinlibCache.clear();
    state.route.query = { filter: 'skin', keyword: 'Knight', page: '1' };
    await settle();

    expect(listMock).toHaveBeenCalledTimes(3);
    expect(wrapper.findAll('.mock-texture-card')).toHaveLength(PER_PAGE);
  });

  it('preloads every page up to the requested one', async () => {
    listMock.mockImplementation(async (params) => pagePayload(params?.page ?? 1, 3));
    state.route.query = { filter: 'skin', page: '3' };
    const wrapper = mountIndex();
    await settle();

    expect(listMock).toHaveBeenCalledTimes(3);
    expect(listMock.mock.calls.map(([params]) => params?.page)).toEqual([1, 2, 3]);
    expect(wrapper.findAll('.mock-texture-card')).toHaveLength(PER_PAGE * 3);
  });

  it('shows the end-of-list hint when everything is loaded', async () => {
    listMock.mockImplementation(async (params) => pagePayload(params?.page ?? 1, 1));
    const wrapper = mountIndex();
    await settle();

    expect(wrapper.text()).toContain('已显示全部材质');
    expect(wrapper.text()).not.toContain('加载更多');
  });

  it('offers a retry when loading the next page fails', async () => {
    listMock.mockImplementation(async (params) => {
      if ((params?.page ?? 1) > 1) throw new Error('boom');
      return pagePayload(1, 2);
    });
    const wrapper = mountIndex();
    await settle();

    FakeIntersectionObserver.instances[0]!.emit();
    await settle();

    expect(wrapper.text()).toContain('网络错误');
    const retry = wrapper.findAll('button').find((button) => button.text().includes('重试'));
    expect(retry).toBeTruthy();

    listMock.mockImplementation(async (params) => pagePayload(params?.page ?? 1, 2));
    await retry!.trigger('click');
    await settle();

    expect(wrapper.findAll('.mock-texture-card')).toHaveLength(PER_PAGE * 2);
    expect(wrapper.text()).toContain('已显示全部材质');
  });
});
