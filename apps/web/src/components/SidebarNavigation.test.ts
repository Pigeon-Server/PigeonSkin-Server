// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SidebarGroup from './SidebarGroup.vue';
import en from '../../../../packages/shared/src/locales/en.json';
import zh_CN from '../../../../packages/shared/src/locales/zh_CN.json';

describe('Sidebar Navigation', () => {
  it('correctly matches active state for subroutes like /tickets/123, /skinlib/456, /votes/7', () => {
    const items = [
      { title: '工单', link: '/tickets', icon: 'support_agent' },
      { title: '个人资料', link: '/profile', icon: 'account_circle' },
    ];
    const wrapper = mount(SidebarGroup, {
      props: {
        title: '账号与支持',
        icon: 'manage_accounts',
        items,
        activePath: '/tickets/123',
      },
      global: {
        stubs: {
          SidebarLink: true,
          AppButton: true,
          AppIcon: true,
          Teleport: true,
        },
      },
    });

    const button = wrapper.findComponent({ name: 'AppButton' });
    expect(button.classes()).toContain('active');
  });

  it('correctly marks inactive when activePath does not match', () => {
    const items = [
      { title: '工单', link: '/tickets', icon: 'support_agent' },
      { title: '个人资料', link: '/profile', icon: 'account_circle' },
    ];
    const wrapper = mount(SidebarGroup, {
      props: {
        title: '账号与支持',
        icon: 'manage_accounts',
        items,
        activePath: '/user',
      },
      global: {
        stubs: {
          SidebarLink: true,
          AppButton: true,
          AppIcon: true,
          Teleport: true,
        },
      },
    });

    const button = wrapper.findComponent({ name: 'AppButton' });
    expect(button.classes()).not.toContain('active');
  });

  it('has localized titles for all sidebar categories in locales', () => {
    expect(zh_CN.sidebar.gameplay).toBe('游戏与换装');
    expect(zh_CN.sidebar.explore_community).toBe('探索与社区');
    expect(zh_CN.sidebar.account_support).toBe('账号与支持');

    expect(en.sidebar.gameplay).toBe('Game & Wardrobe');
    expect(en.sidebar.explore_community).toBe('Explore & Community');
    expect(en.sidebar.account_support).toBe('Account & Support');
  });
});
