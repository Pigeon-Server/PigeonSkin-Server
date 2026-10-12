// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listClosetMock = vi.fn();
const removeClosetMock = vi.fn();
const setAvatarMock = vi.fn();

vi.mock('@/api', () => ({
  closetApi: {
    list: (...args: unknown[]) => listClosetMock(...args),
    remove: (...args: unknown[]) => removeClosetMock(...args),
  },
  meApi: { setAvatar: (...args: unknown[]) => setAvatarMock(...args) },
  textureUrl: (hash: string) => `/textures/${hash}.png`,
  ApiError: class ApiError extends Error {
    status = 0;
    body: unknown = undefined;
  },
}));

vi.mock('@/stores/dialog', () => ({
  confirmAction: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    locale: { value: 'zh_CN' },
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'common.count') return `${params?.count ?? ''}`;
      return key;
    },
    n: (value: number) => String(value),
    d: (value: unknown) => String(value),
  }),
}));

vi.mock('@/components/texture/SkinPreview.vue', () => ({
  default: {
    name: 'SkinPreview',
    props: ['skinUrl', 'slim', 'cape', 'alt'],
    template: '<div class="stub-skin-preview" />',
  },
}));

vi.mock('@/components/texture/TexturePreviewer.vue', () => ({
  default: {
    name: 'TexturePreviewer',
    props: ['skinUrl', 'capeUrl', 'slim', 'name', 'height'],
    template: '<div class="stub-texture-previewer" />',
  },
}));

vi.mock('@/components/texture/ApplyTextureDialog.vue', () => ({
  default: { name: 'ApplyTextureDialog', template: '<div />' },
}));

vi.mock('@/components/search/SearchExpressionField.vue', () => ({
  default: {
    name: 'SearchExpressionField',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input class="stub-search" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
}));

import ClosetIndex from '@/views/closet/Index.vue';
import type { ClosetEntry } from '@/api';

type PendingResolve = (value: unknown) => void;

function entry(textureId: number): ClosetEntry {
  return {
    textureId,
    itemName: `物品 ${textureId}`,
    textureName: `纹理 ${textureId}`,
    hash: `hash_${textureId}`,
    kind: 'skin',
    model: 'default',
    visibility: 'public',
    createdAt: 1680000000000,
  };
}

/** 捕获 IntersectionObserver 回调，用于手动触发「滚动到底追加分页」 */
let observe: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
class StubIntersectionObserver {
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    observe = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

function mountCloset() {
  return mount(ClosetIndex, {
    global: {
      stubs: {
        PageHeader: { template: '<header><slot name="meta" /><slot /></header>' },
        AppIcon: { props: ['name'], template: '<i :data-icon="name" />' },
        AppButton: {
          props: ['disabled', 'loading'],
          template: '<button :disabled="disabled || loading"><slot /></button>',
        },
        AppSelect: { props: ['modelValue', 'options'], template: '<select />' },
        AppSkeleton: { template: '<div class="app-skeleton" />' },
        EmptyState: { props: ['title'], template: '<div class="empty-state">{{ title }}</div>' },
        SkinPreview: { props: ['skinUrl', 'slim', 'cape', 'alt'], template: '<div class="stub-skin-preview" />' },
        ApplyTextureDialog: { template: '<div />' },
        TexturePreviewer: { template: '<div />' },
        SearchExpressionField: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<input class="stub-search" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
      },
    },
  });
}

function deleteButton(wrapper: ReturnType<typeof mountCloset>) {
  return wrapper.findAll('button').find((button) => button.attributes('aria-label') === 'user.removeItem');
}

/** 让下一次列表请求挂起，返回「放行」函数 */
function holdNextListRequest() {
  let release: PendingResolve | undefined;
  listClosetMock.mockImplementationOnce(
    () => new Promise((resolve) => { release = resolve as PendingResolve; }),
  );
  return (value: unknown) => {
    if (!release) throw new Error('list request was not started');
    release(value);
  };
}

const cards = (wrapper: ReturnType<typeof mountCloset>) => wrapper.findAll('article.texture-card').length;

describe('ClosetIndex (views/closet/Index.vue)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listClosetMock.mockReset();
    observe = null;
    listClosetMock.mockResolvedValue({ items: [entry(1), entry(2)], hasMore: false, page: 1 });
  });

  it('shows the skeleton only for the first load', async () => {
    const wrapper = mountCloset();
    expect(wrapper.find('.app-skeleton').exists()).toBe(true);

    await flushPromises();

    expect(wrapper.find('.app-skeleton').exists()).toBe(false);
    expect(cards(wrapper)).toBe(2);
  });

  it('keeps the grid rendered while reloading after removing an item', async () => {
    const wrapper = mountCloset();
    await flushPromises();

    const release = holdNextListRequest();
    removeClosetMock.mockResolvedValue(undefined);

    await deleteButton(wrapper)!.trigger('click');
    await flushPromises();

    expect(removeClosetMock).toHaveBeenCalledWith(1);
    // 刷新期间保留原网格，不再整体换成骨架屏
    expect(wrapper.find('.app-skeleton').exists()).toBe(false);
    expect(cards(wrapper)).toBe(2);

    release({ items: [entry(2)], hasMore: false, page: 1 });
    await flushPromises();

    expect(wrapper.find('.app-skeleton').exists()).toBe(false);
    expect(cards(wrapper)).toBe(1);
  });

  it('keeps the grid rendered while a search refresh is in flight', async () => {
    const wrapper = mountCloset();
    await flushPromises();

    const release = holdNextListRequest();
    await wrapper.find('.stub-search').setValue('冒险');
    await vi.waitFor(() => expect(listClosetMock).toHaveBeenCalledTimes(2));

    expect(wrapper.find('.app-skeleton').exists()).toBe(false);
    expect(cards(wrapper)).toBe(2);

    release({ items: [entry(5)], hasMore: false, page: 1 });
    await flushPromises();
    expect(cards(wrapper)).toBe(1);
  });

  it('falls back to the skeleton when a silent refresh has nothing to keep', async () => {
    const wrapper = mountCloset();
    await flushPromises();

    // 先让列表变成空结果
    listClosetMock.mockResolvedValueOnce({ items: [], hasMore: false, page: 1 });
    await wrapper.find('.stub-search').setValue('没有结果');
    await vi.waitFor(() => expect(cards(wrapper)).toBe(0));

    // 空列表下再刷新：没有可保留的内容，仍用骨架屏占位（而不是显示「衣柜为空」）
    const release = holdNextListRequest();
    await wrapper.find('.stub-search').setValue('仍然没有结果');
    await vi.waitFor(() => expect(wrapper.find('.app-skeleton').exists()).toBe(true));

    release({ items: [entry(7)], hasMore: false, page: 1 });
    await flushPromises();
    expect(cards(wrapper)).toBe(1);
  });

  it('drops a stale append when a silent refresh supersedes it', async () => {
    const firstPage = Array.from({ length: 24 }, (_, index) => entry(index + 1));
    listClosetMock.mockResolvedValueOnce({ items: firstPage, hasMore: true, page: 1 });

    const wrapper = mountCloset();
    await flushPromises();
    expect(cards(wrapper)).toBe(24);

    // 追加分页挂起
    const releaseAppend = holdNextListRequest();
    observe!([{ isIntersecting: true }]);

    // 追加在飞时发起静默刷新（删除物品）
    removeClosetMock.mockResolvedValue(undefined);
    listClosetMock.mockResolvedValueOnce({ items: [entry(99)], hasMore: false, page: 1 });
    await deleteButton(wrapper)!.trigger('click');
    await flushPromises();
    expect(cards(wrapper)).toBe(1);

    // 被取代的追加结果返回后不得并入列表
    releaseAppend({ items: [entry(25)], hasMore: false, page: 2 });
    await flushPromises();
    expect(cards(wrapper)).toBe(1);
    expect(listClosetMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));

    // 代际收尾正确：被取代的 append 没有把 loadingMore 卡住——再滚到底仍能继续追加
    listClosetMock.mockResolvedValueOnce({ items: [entry(1), entry(2), entry(3)], hasMore: true, page: 1 });
    await deleteButton(wrapper)!.trigger('click');
    await flushPromises();
    expect(cards(wrapper)).toBe(3);

    listClosetMock.mockResolvedValueOnce({ items: [entry(4)], hasMore: false, page: 2 });
    observe!([{ isIntersecting: true }]);
    await flushPromises();

    expect(listClosetMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(cards(wrapper)).toBe(4);
  });
});
