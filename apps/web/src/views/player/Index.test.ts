// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/components/TexturePreviewer.vue', () => ({
  default: {
    name: 'TexturePreviewer',
    props: ['skinUrl', 'capeUrl', 'slim', 'name', 'height'],
    template: '<div class="stub-texture-previewer" :data-skin="skinUrl" :data-cape="capeUrl" :data-slim="slim" :data-name="name"></div>',
  },
}));

vi.mock('@/components/SkinPreview.vue', () => ({
  default: {
    name: 'SkinPreview',
    props: ['skinUrl', 'slim', 'cape', 'alt'],
    template: '<div class="stub-skin-preview" :data-skin="skinUrl" :data-slim="slim" :data-cape="cape"></div>',
  },
}));

vi.mock('@/components/AvatarPreview.vue', () => ({
  default: {
    name: 'AvatarPreview',
    props: ['hash', 'name'],
    template: '<div class="stub-avatar-preview" :data-hash="hash" :data-name="name"></div>',
  },
}));

import PlayerIndex from '@/views/player/Index.vue';
import type { PlayerSummary, ClosetEntry, TextureSummary } from '@/api';

// ── Mock 数据 ─────────────────────────────────────────────────────────────

const mockPlayers: PlayerSummary[] = [
  {
    id: 1,
    name: 'Steve_01',
    skinTextureId: 101,
    skinHash: 'skin_hash_101',
    skinModel: 'default',
    capeTextureId: 201,
    capeHash: 'cape_hash_201',
    createdAt: 1680000000000,
    updatedAt: 1680000000000,
  },
  {
    id: 2,
    name: 'Alex_02',
    skinTextureId: 102,
    skinHash: 'skin_hash_102',
    skinModel: 'slim',
    capeTextureId: null,
    capeHash: null,
    createdAt: 1680001000000,
    updatedAt: 1680001000000,
  },
];

const mockCloset: ClosetEntry[] = [
  {
    textureId: 101,
    itemName: '我的冒险皮肤',
    textureName: 'Adventure Steve',
    hash: 'skin_hash_101',
    kind: 'skin',
    model: 'default',
    visibility: 'public',
    createdAt: 1680000000000,
  },
  {
    textureId: 102,
    itemName: null,
    textureName: 'Slim Alex Skin',
    hash: 'skin_hash_102',
    kind: 'skin',
    model: 'slim',
    visibility: 'public',
    createdAt: 1680000000000,
  },
  {
    textureId: 201,
    itemName: '创始者披风',
    textureName: 'Founder Cape',
    hash: 'cape_hash_201',
    kind: 'cape',
    model: null,
    visibility: 'public',
    createdAt: 1680000000000,
  },
];

const mockOfficials: TextureSummary[] = [
  {
    id: 999,
    name: 'Mojang 经典披风',
    kind: 'cape',
    model: null,
    hash: 'official_cape_hash_999',
    width: 64,
    height: 32,
    sizeBytes: 2048,
    likes: 99,
    visibility: 'public',
    official: true,
    uploaderId: 1,
    uploaderName: 'Mojang',
    sourceResourceId: null,
    sourceResourceName: null,
    origin: 'original',
    createdAt: 1680000000000,
  },
];

const listPlayersMock = vi.fn();
const createPlayerMock = vi.fn();
const renamePlayerMock = vi.fn();
const removePlayerMock = vi.fn();
const setTexturesMock = vi.fn();
const listClosetMock = vi.fn();
const listTexturesMock = vi.fn();

vi.mock('@/api', () => ({
  playerApi: {
    list: () => listPlayersMock(),
    create: (name: string) => createPlayerMock(name),
    rename: (id: number, name: string) => renamePlayerMock(id, name),
    remove: (id: number) => removePlayerMock(id),
    setTextures: (id: number, body: unknown) => setTexturesMock(id, body),
  },
  closetApi: {
    list: (query: unknown) => listClosetMock(query),
  },
  textureApi: {
    list: (query: unknown) => listTexturesMock(query),
  },
  textureUrl: (hash: string) => `/textures/${hash}.png`,
}));

const mockSiteSettings: Record<string, string> = {
  player_name_rule: 'official',
  player_name_length_min: '3',
  player_name_length_max: '16',
  score_per_player: '100',
};

vi.mock('@/stores/site', () => ({
  useSiteSettings: () => ({
    get: (key: string) => mockSiteSettings[key] ?? '',
    fetch: vi.fn(),
  }),
}));

const fetchSessionMock = vi.fn();
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    fetchSession: fetchSessionMock,
  }),
}));

const confirmActionMock = vi.fn().mockResolvedValue(true);
vi.mock('@/stores/dialog', () => ({
  confirmAction: (msg: string) => confirmActionMock(msg),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'general.player-manage': '角色管理',
        'general.player-name': '角色名',
        'general.skin': '皮肤',
        'general.cape': '披风',
        'general.search': '搜索',
        'general.notice': '提示',
        'general.op-success': '操作成功',
        'common.save': '保存',
        'common.cancel': '取消',
        'common.rename': '重命名',
        'common.delete': '删除',
        'common.retry': '重试',
        'common.none': '未设置',
        'player.create': '添加角色',
        'player.new': '添加新角色',
        'player.select': '选择角色',
        'player.empty': '你好像还没有添加任何角色哦',
        'player.previewing_unsaved': '正在预览未保存的外观',
        'player.save_textures': '保存装扮',
        'player.reset_preview': '还原外观',
        'player.previewing': '预览中',
        'player.wearing': '已穿戴',
        'player.copy_name': '复制角色名',
        'player.name_copied': '角色名已复制',
        'player.source_all': '全部材质',
        'player.source_closet': '我的衣柜',
        'player.source_official': '官方材质',
        'player.clear_skin': '清除皮肤',
        'player.clear_cape': '清除披风',
        'player.login_notice': '你可以使用你所拥有的角色名来登录皮肤站。',
        'player.texture_empty': '未设置材质',
        'admin.setting.player_name_rule': '角色名规则',
        'admin.option.official': '官方格式',
        'skinlib.filter.official': 'Mojang 官方',
        'skinlib.filter.steve': 'Steve · 标准',
        'skinlib.filter.alex': 'Alex · 纤细',
        'home.cta_browse': '去皮肤库逛逛',
        'user.no_textures_ext': '暂无可用材质',
      };
      if (key === 'player.cost' && params?.score) {
        return `添加角色消耗 ${params.score} 积分`;
      }
      if (key === 'player.delete_confirm' && params?.name) {
        return `确认删除角色 ${params.name}？`;
      }
      return messages[key] ?? key;
    },
    n: (val: number) => String(val),
  }),
}));

describe('PlayerIndex (views/player/Index.vue)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPlayersMock.mockResolvedValue({ items: [...mockPlayers] });
    listClosetMock.mockResolvedValue({ items: [...mockCloset], page: 1, hasMore: false });
    listTexturesMock.mockResolvedValue({ items: [...mockOfficials], total: 1 });
  });

  function mountView() {
    return mount(PlayerIndex, {
      global: {
        components: {
          AppIcon: {
            props: ['name'],
            template: '<span class="app-icon" :data-icon="name"></span>',
          },
          AppButton: {
            props: ['disabled', 'loading'],
            template: '<button :disabled="disabled || loading"><slot /></button>',
          },
        },
        stubs: {
          TexturePreviewer: {
            props: ['skinUrl', 'capeUrl', 'slim', 'name', 'height'],
            template: '<div class="stub-texture-previewer" :data-skin="skinUrl" :data-cape="capeUrl" :data-slim="slim" :data-name="name"></div>',
          },
          SkinPreview: {
            props: ['skinUrl', 'slim', 'cape', 'alt'],
            template: '<div class="stub-skin-preview" :data-skin="skinUrl" :data-slim="slim" :data-cape="cape"></div>',
          },
          AvatarPreview: {
            props: ['hash', 'name'],
            template: '<div class="stub-avatar-preview" :data-hash="hash" :data-name="name"></div>',
          },
          RouterLink: {
            props: ['to'],
            template: '<a :href="to"><slot /></a>',
          },
        },
      },
    });
  }

  it('renders players list and selects first player by default', async () => {
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('角色管理');
    expect(wrapper.text()).toContain('Steve_01');
    expect(wrapper.find('.stub-texture-previewer').attributes('data-name')).toBe('Steve_01');
    expect(wrapper.find('.stub-texture-previewer').attributes('data-skin')).toBe('/textures/skin_hash_101.png');
    expect(wrapper.find('.stub-texture-previewer').attributes('data-cape')).toBe('/textures/cape_hash_201.png');
  });

  it('updates preview when selecting a texture and commits on explicit save', async () => {
    const wrapper = mountView();
    await flushPromises();

    // 默认未修改，不展示未保存提示条
    expect(wrapper.text()).not.toContain('正在预览未保存的外观');

    // 点击第二个皮肤（Alex 皮肤，ID 102）
    const textureButtons = wrapper.findAll('button.group');
    expect(textureButtons.length).toBeGreaterThan(0);

    const slimSkinBtn = textureButtons.find((btn) => btn.text().includes('Slim Alex Skin'));
    expect(slimSkinBtn).toBeDefined();

    await slimSkinBtn!.trigger('click');
    await flushPromises();

    // 规则：材质选择先更新预览，再由用户明确保存
    expect(wrapper.text()).toContain('正在预览未保存的外观');
    expect(wrapper.find('.stub-texture-previewer').attributes('data-skin')).toBe('/textures/skin_hash_102.png');
    expect(wrapper.find('.stub-texture-previewer').attributes('data-slim')).toBe('true');
    expect(setTexturesMock).not.toHaveBeenCalled();

    // 点击“保存装扮”按钮
    setTexturesMock.mockResolvedValue({ ok: true });
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存装扮'));
    expect(saveBtn).toBeDefined();

    await saveBtn!.trigger('click');
    await flushPromises();

    expect(setTexturesMock).toHaveBeenCalledWith(1, { skin: 102 });
  });

  it('resets preview changes when clicking reset preview button', async () => {
    const wrapper = mountView();
    await flushPromises();

    const textureButtons = wrapper.findAll('button.group');
    const slimSkinBtn = textureButtons.find((btn) => btn.text().includes('Slim Alex Skin'));
    await slimSkinBtn!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('正在预览未保存的外观');
    expect(wrapper.find('.stub-texture-previewer').attributes('data-skin')).toBe('/textures/skin_hash_102.png');

    // 点击“还原外观”
    const resetBtn = wrapper.findAll('button').find((b) => b.text().includes('还原外观'));
    expect(resetBtn).toBeDefined();

    await resetBtn!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).not.toContain('正在预览未保存的外观');
    // 恢复成原本的 skin 101
    expect(wrapper.find('.stub-texture-previewer').attributes('data-skin')).toBe('/textures/skin_hash_101.png');
  });

  it('clears skin slot and previews removal until explicitly saved', async () => {
    const wrapper = mountView();
    await flushPromises();

    // 点击“清除皮肤”
    const clearSkinBtn = wrapper.findAll('button').find((b) => b.text().includes('清除皮肤'));
    expect(clearSkinBtn).toBeDefined();

    await clearSkinBtn!.trigger('click');
    await flushPromises();

    // 皮肤被清除，预览为 null，进入未保存提示
    expect(wrapper.text()).toContain('正在预览未保存的外观');
    expect(wrapper.find('.stub-texture-previewer').attributes('data-skin')).toBeUndefined();
    expect(setTexturesMock).not.toHaveBeenCalled();

    // 明确保存
    setTexturesMock.mockResolvedValue({ ok: true });
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存装扮'));
    await saveBtn!.trigger('click');
    await flushPromises();

    expect(setTexturesMock).toHaveBeenCalledWith(1, { skin: null });
  });

  it('supports official textures alongside closet textures', async () => {
    const wrapper = mountView();
    await flushPromises();

    // 切换到披风 Tab
    const capeTab = wrapper.findAll('.filter-tabs button').find((b) => b.text().includes('披风'));
    expect(capeTab).toBeDefined();
    await capeTab!.trigger('click');
    await flushPromises();

    // 列表中应该包含官方披风（Mojang 经典披风）
    expect(wrapper.text()).toContain('Mojang 经典披风');
    expect(wrapper.text()).toContain('Mojang 官方');

    // 点击试穿官方披风
    const officialBtn = wrapper.findAll('button.group').find((b) => b.text().includes('Mojang 经典披风'));
    expect(officialBtn).toBeDefined();

    await officialBtn!.trigger('click');
    await flushPromises();

    expect(wrapper.find('.stub-texture-previewer').attributes('data-cape')).toBe('/textures/official_cape_hash_999.png');
  });

  it('creates new player via create dialog', async () => {
    const wrapper = mountView();
    await flushPromises();

    createPlayerMock.mockResolvedValue({ id: 3, scoreSpent: 100 });

    // 点击打开“添加角色”
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加角色'));
    expect(addBtn).toBeDefined();
    await addBtn!.trigger('click');
    await flushPromises();

    // 填写新角色名并提交表单
    const input = wrapper.find('#new-player-name');
    expect(input.exists()).toBe(true);
    await input.setValue('Hero_Steve');

    const form = wrapper.find('form');
    await form.trigger('submit.prevent');
    await flushPromises();

    expect(createPlayerMock).toHaveBeenCalledWith('Hero_Steve');
  });

  it('renames player via rename dialog', async () => {
    const wrapper = mountView();
    await flushPromises();

    renamePlayerMock.mockResolvedValue({ ok: true });

    // 点击编辑重命名图标
    const renameBtn = wrapper.find('button[aria-label="重命名"]');
    expect(renameBtn.exists()).toBe(true);
    await renameBtn.trigger('click');
    await flushPromises();

    const input = wrapper.find('#rename-player-name');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe('Steve_01');

    await input.setValue('Steve_Pro');
    const form = wrapper.findAll('form').find((f) => f.find('#rename-player-name').exists());
    await form!.trigger('submit.prevent');
    await flushPromises();

    expect(renamePlayerMock).toHaveBeenCalledWith(1, 'Steve_Pro');
  });

  it('deletes player after confirmation', async () => {
    const wrapper = mountView();
    await flushPromises();

    removePlayerMock.mockResolvedValue(undefined);

    const deleteBtn = wrapper.find('button[aria-label="删除"]');
    expect(deleteBtn.exists()).toBe(true);
    await deleteBtn.trigger('click');
    await flushPromises();

    expect(confirmActionMock).toHaveBeenCalledWith('确认删除角色 Steve_01？');
    expect(removePlayerMock).toHaveBeenCalledWith(1);
  });

  it('shows empty state when user has no players', async () => {
    listPlayersMock.mockResolvedValue({ items: [] });
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('你好像还没有添加任何角色哦');
  });
});
