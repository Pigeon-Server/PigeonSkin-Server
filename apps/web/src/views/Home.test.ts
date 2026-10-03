// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import HomeView from '@/views/Home.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const localeRef = ref('zh_CN');

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    user: { value: null },
  }),
}));

vi.mock('@/stores/site', () => ({
  useSiteSettings: () => ({
    get: (key: string) => {
      if (key === 'registration_enabled') return 'true';
      if (key === 'home_show_intro') return 'true';
      return '';
    },
  }),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    locale: localeRef,
    t: (key: string) => {
      const messages: Record<string, string> = {
        'home.product': 'MINECRAFT SKIN SERVER',
        'home.hero_title': '每个方块世界，都有你的模样。',
        'home.hero_title_2': '皮肤与披风，配出你的风格。',
        'home.hero_title_3': '收藏心仪皮肤，随时切换。',
        'home.hero_title_4': '我的角色，我的风格。',
        'home.hero_title_5': '挑好今日造型，再去冒险。',
        'home.hero_description': '发现新的皮肤与披风，搭配你的角色。',
        'home.cta_browse': '浏览皮肤库',
        'home.cta_register': '立即注册',
        'home.compatibility': '支持 CustomSkinLoader 与 authlib-injector',
        'home.f_upload_title': '属于你的皮肤与披风',
        'home.f_upload_body': '上传、收藏和分享皮肤与披风。',
        'home.f_player_title': '一个账号，多种角色',
        'home.f_player_body': '为不同角色管理独立的皮肤与披风。',
        'home.f_api_title': '连接你的方块世界',
        'home.f_api_body': '通过皮肤加载器和外置登录。',
        'general.user-center': '用户中心',
        'general.login': '登录',
        'general.explore': '查看',
      };
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
          name: 'Classic Alex',
          hash: 'alex-hash',
          model: 'slim',
          uploaderName: 'Mojang',
        },
      ],
    }),
  },
  textureUrl: (hash: string) => `/textures/${hash}.png`,
}));

vi.mock('@/components/SkinViewer.vue', () => ({
  default: {
    props: ['skinUrl', 'slim', 'height', 'animated', 'controls'],
    template: '<div class="mock-skin-viewer"></div>',
  },
}));

function createHomeWrapper() {
  return mount(HomeView, {
    global: {
      components: {
        AppButton,
        AppIcon,
        'router-link': {
          props: ['to'],
          template: '<a :href="to"><slot /></a>',
        },
      },
    },
  });
}

describe('Home View', () => {
  it('renders branding badge, headline, and primary call to actions', () => {
    const wrapper = createHomeWrapper();
    const text = wrapper.text();
    expect(text).toContain('MINECRAFT SKIN SERVER');
    expect(text).toContain('每个方块世界');
    expect(text).toContain('浏览皮肤库');
    expect(text).toContain('立即注册');
    expect(text).toContain('支持 CustomSkinLoader 与 authlib-injector');
  });

  it('renders feature section cards', () => {
    const wrapper = createHomeWrapper();
    const text = wrapper.text();
    expect(text).toContain('属于你的皮肤与披风');
    expect(text).toContain('一个账号，多种角色');
    expect(text).toContain('连接你的方块世界');
  });
});
