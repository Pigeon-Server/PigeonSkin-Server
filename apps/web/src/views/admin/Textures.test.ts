// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminTextures from '@/views/admin/Textures.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';
import { confirmAction } from '@/stores/dialog';
import type { AdminTextureRow } from '@/api';

const mockTextures = vi.fn();
const mockBatch = vi.fn();
const mockDelete = vi.fn();
const mockPatch = vi.fn();
const mockPreviewUrl = vi.fn((hash: string, texture: { kind: string }) => `/preview/${hash}?kind=${texture.kind}`);
const mockAvatarUrl = vi.fn((hash: string, opts: { size?: number } = {}) => `/avatar/${hash}?size=${opts.size ?? 100}&render=3`);

vi.mock('@/api', () => ({
  adminApi: {
    textures: (...args: unknown[]) => mockTextures(...args),
    batchTextures: (...args: unknown[]) => mockBatch(...args),
    deleteTexture: (...args: unknown[]) => mockDelete(...args),
    patchTexture: (...args: unknown[]) => mockPatch(...args),
  },
  previewUrl: (...args: unknown[]) => mockPreviewUrl(...(args as [string, { kind: string }])),
  avatarUrl: (...args: unknown[]) => mockAvatarUrl(...(args as [string, { size?: number }])),
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/stores/dialog', () => ({
  confirmAction: vi.fn().mockResolvedValue(true),
  promptValue: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    locale: { value: 'zh_CN' },
    t: (key: string) => {
      const messages: Record<string, string> = {
        'skinlib.official_resource': 'Mojang 官方',
        'admin.anonymous': '已注销',
        'admin.texture_selected': '{count} selected',
      };
      return messages[key] ?? key;
    },
    n: (v: number) => String(v),
    d: (v: number) => new Date(v).toISOString().slice(0, 10),
  }),
}));

function row(overrides: Partial<AdminTextureRow>): AdminTextureRow {
  return {
    id: 1,
    hash: 'a'.repeat(64),
    name: 'Test Skin',
    kind: 'skin',
    model: 'default',
    visibility: 'public',
    sizeBytes: 1024,
    likes: 3,
    uploaderId: 7,
    uploaderName: 'Alice',
    official: false,
    createdAt: 0,
    ...overrides,
  };
}

function paged(items: AdminTextureRow[]) {
  return { items, page: 1, perPage: 20, total: items.length, totalPages: 1 };
}

function createWrapper() {
  return mount(AdminTextures, {
    global: {
      components: { AppButton, AppCheckbox, AppIcon, AppInput, AppSkeleton, PageHeader, SearchExpressionField },
      // 悬停卡 Teleport 到 body；stub 掉 teleport 让内容留在 wrapper 内便于断言
      stubs: { 'router-link': { template: '<a><slot /></a>' }, teleport: true },
    },
  });
}

/** 等一次渲染 + 首屏 load 完成 */
async function mountLoaded(items: AdminTextureRow[]) {
  mockTextures.mockResolvedValue(paged(items));
  const wrapper = createWrapper();
  await flushPromises();
  return wrapper;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  mockTextures.mockReset();
  mockBatch.mockReset();
  mockDelete.mockReset();
  mockPatch.mockReset();
  mockPreviewUrl.mockClear();
  mockAvatarUrl.mockClear();
  // jsdom 的 matchMedia 一律返回 matches: false，会把组件判定成"无悬停设备"
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }));
});

describe('AdminTextures View', () => {
  it('renders official textures as 官方资源 instead of 已注销 in uploader column', async () => {
    const wrapper = await mountLoaded([
      row({ id: 101, official: true, uploaderId: null, uploaderName: null }),
      row({ id: 102, official: false }),
      row({ id: 103, official: false, uploaderId: null, uploaderName: null }),
    ]);
    const html = wrapper.html();
    expect(html).toContain('Mojang 官方');
    expect(html).toContain('已注销');
    expect(html).toContain('Alice');
    // 官方行的上传者列是官方资源；非官方无主行才显示已注销
    const officialRow = wrapper.findAll('tbody tr').find(tr => tr.text().includes('#101'));
    expect(officialRow).toBeTruthy();
    expect(officialRow!.html()).not.toContain('已注销');
    expect(officialRow!.html()).toContain('Mojang 官方');
  });

  it('列表缩略图：皮肤用头像，披风退回整张预览（/avatar 对披风 422）', async () => {
    const wrapper = await mountLoaded([
      row({ id: 1, kind: 'cape', model: null, hash: 'c'.repeat(64) }),
      row({ id: 2, kind: 'skin', model: 'slim', hash: 'd'.repeat(64) }),
    ]);
    const sources = wrapper.findAll('tbody img').map(img => img.attributes('src'));
    expect(sources).toHaveLength(2);
    expect(sources[0]).toContain(`/preview/${'c'.repeat(64)}?kind=cape`);
    expect(sources[1]).toContain(`/avatar/${'d'.repeat(64)}`);
    // 披风绝不能落到头像端点
    expect(sources[0]).not.toContain('/avatar/');
    expect(mockPreviewUrl).toHaveBeenCalledWith('c'.repeat(64), expect.objectContaining({ kind: 'cape' }));
  });

  it('把类型筛选作为查询参数传给接口并回到第一页', async () => {
    const wrapper = await mountLoaded([row({ id: 1 })]);
    expect(mockTextures).toHaveBeenLastCalledWith(expect.objectContaining({ kind: undefined, page: 1 }));

    const capes = wrapper.findAll('[role="group"] button').find(button => button.text() === 'general.cape');
    expect(capes).toBeTruthy();
    await capes!.trigger('click');
    await flushPromises();
    expect(mockTextures).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'cape', page: 1 }));
  });

  it('选中行后批量改可见性，只提交选中的 id', async () => {
    const wrapper = await mountLoaded([
      row({ id: 11, name: 'A' }),
      row({ id: 12, name: 'B' }),
      row({ id: 13, name: 'C' }),
    ]);
    expect(wrapper.text()).not.toContain('admin.texture_batch_public');

    const boxes = wrapper.findAll('tbody [role="checkbox"]');
    await boxes[0]!.trigger('click');
    await boxes[2]!.trigger('click');
    await flushPromises();

    const toolbar = wrapper.findAll('[role="group"]').find(group => group.text().includes('admin.texture_batch_public'));
    expect(toolbar).toBeTruthy();
    const makePrivate = toolbar!.findAll('button').find(button => button.text() === 'admin.texture_batch_private');
    expect(makePrivate).toBeTruthy();

    mockBatch.mockResolvedValue({ affected: 2 });
    mockTextures.mockResolvedValue(paged([row({ id: 11 })]));
    await makePrivate!.trigger('click');
    await flushPromises();
    expect(mockBatch).toHaveBeenCalledWith({ action: 'visibility', ids: [11, 13], visibility: 'private' });
  });

  it('批量删除先确认，再按删除动作提交', async () => {
    const wrapper = await mountLoaded([row({ id: 21, name: 'A' }), row({ id: 22, name: 'B' })]);

    // 表头全选
    const headerBox = wrapper.find('thead [role="checkbox"]');
    await headerBox.trigger('click');
    await flushPromises();

    mockBatch.mockResolvedValue({ affected: 2 });
    mockTextures.mockResolvedValue(paged([]));
    const remove = wrapper.findAll('[role="group"] button').find(button => button.text() === 'common.delete');
    expect(remove).toBeTruthy();
    await remove!.trigger('click');
    await flushPromises();

    expect(confirmAction).toHaveBeenCalledWith('admin.texture_batch_delete_confirm');
    expect(mockBatch).toHaveBeenCalledWith({ action: 'delete', ids: [21, 22] });
  });

  it('悬停名称时浮出材质卡，移开后收回', async () => {
    const wrapper = await mountLoaded([row({ id: 41, name: 'Hover', kind: 'cape', model: null, likes: 5 })]);
    expect(wrapper.find('.texture-hover-card').exists()).toBe(false);

    const trigger = wrapper.find('tbody a > span');
    expect(trigger.exists()).toBe(true);
    await trigger.trigger('mouseenter');
    await wait(320);
    await flushPromises();

    const card = wrapper.find('.texture-hover-card');
    expect(card.exists()).toBe(true);
    // 披风卡走披风预览，并带上类型与收藏数
    expect(card.html()).toContain(`/preview/${'a'.repeat(64)}?kind=cape`);
    expect(card.html()).toContain('general.cape');
    expect(card.html()).toContain('5');

    await trigger.trigger('mouseleave');
    await wait(200);
    await flushPromises();
    expect(wrapper.find('.texture-hover-card').exists()).toBe(false);
  });

  it('官方来源筛选作为 official=true 传给接口', async () => {
    const wrapper = await mountLoaded([row({ id: 1 })]);
    const officialChip = wrapper.findAll('[role="group"] button').find(button => button.text() === 'Mojang 官方');
    expect(officialChip).toBeTruthy();
    await officialChip!.trigger('click');
    await flushPromises();
    expect(mockTextures).toHaveBeenLastCalledWith(expect.objectContaining({ official: true, page: 1 }));
  });

  it('无悬停能力的设备不弹材质卡', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }));
    const wrapper = await mountLoaded([row({ id: 51, name: 'Touch' })]);
    await wrapper.find('tbody a > span').trigger('mouseenter');
    await wait(320);
    await flushPromises();
    expect(wrapper.find('.texture-hover-card').exists()).toBe(false);
  });

  it('翻页后不保留上一页的选择', async () => {
    mockTextures.mockResolvedValue({ ...paged([row({ id: 31, name: 'A' })]), totalPages: 2 });
    const wrapper = createWrapper();
    await flushPromises();
    await wrapper.find('tbody [role="checkbox"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('admin.texture_batch_public');

    // 第二页只含另一行：选择集里已经看不见的 id 要被丢掉
    mockTextures.mockResolvedValue({ ...paged([row({ id: 32, name: 'B' })]), page: 2, totalPages: 2 });
    const next = wrapper.findAll('button').find(button => button.text() === 'common.next');
    expect(next).toBeTruthy();
    await next!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('admin.texture_batch_public');
  });
});
