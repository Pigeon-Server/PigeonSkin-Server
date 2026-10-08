// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import UserIndex from '@/views/user/Index.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppAlert from '@/components/ui/AppAlert.vue';
import AppDialog from '@/components/ui/AppDialog.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import MarkdownContent from '@/components/ui/MarkdownContent.vue';

const mockUser = {
  id: 1,
  nickname: 'Steve',
  email: 'steve@minecraft.net',
  role: 'normal',
  score: 1000,
  emailVerified: true,
  avatarTextureId: null,
};

const sessionUser = { value: { ...mockUser } };
const sessionIsAdmin = { value: false };
const fetchSessionMock = vi.fn();

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    user: sessionUser,
    isAdmin: sessionIsAdmin,
    fetchSession: fetchSessionMock,
  }),
}));

const mockSiteSettings: Record<string, string> = {
  require_email_verification: 'true',
  ygg_show_config_section: 'true',
  initial_score: '500',
  refund_on_delete: 'true',
  mojang_verification_score_award: '100',
  announcement: '欢迎来到鸽子皮肤站！',
};

const fetchSiteMock = vi.fn();

vi.mock('@/stores/site', () => ({
  useSiteSettings: () => ({
    get: (key: string) => mockSiteSettings[key] ?? '',
    fetch: fetchSiteMock,
  }),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'general.user-center': '用户中心',
        'general.profile': '个人资料',
        'general.player-manage': '角色管理',
        'general.my-closet': '我的衣柜',
        'general.skinlib': '皮肤库',
        'security.title': '账户安全',
        'ticket.title': '工单',
        'votes.title': '投票',
        'dash.score': '积分',
        'user.cur-score': '当前积分',
        'user.score-notice': '点击积分查看说明',
        'dash.score_details': '积分说明',
        'dash.sign': '签到',
        'user.sign': '每日签到',
        'dash.signed': '今日已签到',
        'user.signed_ext': '已签到',
        'dash.upload': '上传材质',
        'dash.quick_actions': '快捷入口',
        'dash.manage_players': '管理游戏角色与材质绑定',
        'dash.manage_closet': '整理收藏的皮肤与披风',
        'dash.explore_skinlib': '浏览与发现社区公开材质',
        'dash.upload_texture': '上传你的专属皮肤或披风',
        'dash.support_tickets': '提交工单获取管理员协助',
        'dash.community_votes': '参与社区活动与提案表决',
        'user.used.title': '使用情况',
        'user.used.players': '角色数量',
        'user.used.storage': '存储空间',
        'dash.announcement': '站点公告',
        'dash.no_announcement': '暂无公告',
        'settings.mojang': '正版验证',
        'settings.mojang_go_verify': '前往验证',
        'settings.mojang_unavailable': '正版验证暂不可用',
        'integration.mojang.verify_notice': '绑定正版 Minecraft 角色可同步官方材质并获得积分奖励。',
        'dash.verified_badge': '已验证',
        'dash.unverified_badge': '未验证',
        'dash.verified_status': '正版角色已绑定，官方材质已互通',
        'admin.role_normal': '普通用户',
        'admin.role_admin': '管理员',
        'admin.role_super': '超级管理员',
        'admin.role_banned': '已封禁',
        'user.unverified_ext': '邮箱尚未验证，部分功能可能受限',
        'user.verification.send_ext': '发送验证邮件',
        'user.verification.success': '验证邮件已发送，请检查你的收件箱。',
        'common.close': '关闭',
        'common.retry': '重试',
        'common.unlimited': '无限制',
        'common.edit': '编辑',
        'admin.setting.score_per_player': '每个角色的积分消耗',
        'admin.setting.score_per_kb_public': '公开材质每 KB 积分消耗',
        'admin.setting.score_per_kb_private': '私密材质每 KB 积分消耗',
        'admin.setting.score_per_closet_item': '收藏材质的积分消耗',
        'dash.score_intro_text': '本站启用积分系统以合理分配存储与计算资源。',
        'dash.general_rules': '基础规则',
        'dash.rate_rules': '积分消耗明细',
        'dash.refund_enabled': '删除材质时返还存储积分。',
        'dash.refund_disabled': '删除材质时不返还存储积分。',
      };
      if (key === 'dash.signed_reward' && params) {
        return `签到成功，获得了 ${params.score} 积分`;
      }
      if (key === 'dash.next_sign' && params) {
        return `下次签到：${params.date}`;
      }
      if (key === 'dash.sign_reward_range' && params) {
        return `每次签到可以随机获得 ${params.min} ~ ${params.max} 积分`;
      }
      if (key === 'dash.initial_score' && params) {
        return `注册时获得 ${params.score} 初始积分。`;
      }
      if (key === 'dash.verification_reward' && params) {
        return `首次完成正版验证可获得 ${params.score} 积分。`;
      }
      if (key === 'dash.usage_ratio' && params) {
        return `${params.used} / ${params.total}`;
      }
      if (key === 'dash.storage_ratio' && params) {
        return `${params.used} / ${params.total} KB`;
      }
      return messages[key] || key;
    },
    n: (num: number) => String(num),
    d: (date: number | string) => String(date),
  }),
}));

const mockScoreData = {
  score: 1200,
  canSignIn: true,
  nextSignAt: null,
  signReward: { min: 10, max: 50 },
  usage: { players: 2, storageKb: 128 },
  rates: {
    perPlayer: 100,
    perKbPublic: 2,
    perKbPrivate: 5,
    perClosetItem: 10,
  },
};

const mockMojangData = {
  available: true,
  verified: false,
};

const meScoreMock = vi.fn().mockResolvedValue(mockScoreData);
const meSignMock = vi.fn().mockResolvedValue({ reward: 35, score: 1235 });
const mojangStatusMock = vi.fn().mockResolvedValue(mockMojangData);
const verifyEmailRequestMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock('@/api', () => ({
  meApi: {
    score: () => meScoreMock(),
    sign: () => meSignMock(),
  },
  mojangApi: {
    status: () => mojangStatusMock(),
  },
  api: {
    verifyEmailRequest: () => verifyEmailRequestMock(),
  },
}));

vi.mock('@/components/UserAvatar.vue', () => ({
  default: {
    name: 'UserAvatar',
    props: ['textureId', 'userId', 'name'],
    template: '<div data-test="user-avatar" :data-user-id="userId">{{ name }}</div>',
  },
}));

vi.mock('@/components/LauncherSetup.vue', () => ({
  default: {
    name: 'LauncherSetup',
    template: '<div data-test="launcher-setup">Launcher Setup Component</div>',
  },
}));

function mountComponent() {
  return mount(UserIndex, {
    global: {
      components: {
        AppButton,
        AppIcon,
        AppAlert,
        AppDialog,
        AppSkeleton,
        EmptyState,
        PageHeader,
        MarkdownContent,
        RouterLink: {
          props: ['to'],
          template: '<a :href="to"><slot /></a>',
        },
      },
    },
  });
}

describe('User Dashboard (Index.vue)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionUser.value = { ...mockUser };
    sessionIsAdmin.value = false;
    meScoreMock.mockResolvedValue({ ...mockScoreData });
    mojangStatusMock.mockResolvedValue({ ...mockMojangData });
  });

  it('renders user center profile summary with nickname, email, uid, and role', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    expect(wrapper.text()).toContain('用户中心');
    expect(wrapper.text()).toContain('Steve');
    expect(wrapper.text()).toContain('steve@minecraft.net');
    expect(wrapper.text()).toContain('UID: 1');
    expect(wrapper.text()).toContain('普通用户');
    expect(wrapper.find('[data-test="user-avatar"]').exists()).toBe(true);
  });

  it('renders resource quota metrics with players and storage calculations', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    expect(wrapper.text()).toContain('角色数量');
    expect(wrapper.text()).toContain('存储空间');
    // capacity: 2 + floor(1200 / 100) = 14
    expect(wrapper.text()).toContain('2 / 14');
    // storage: 128 + floor(1200 / 2) = 728
    expect(wrapper.text()).toContain('128 / 728 KB');
  });

  it('executes sign-in successfully and updates score with feedback', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const signButton = wrapper.findAllComponents(AppButton).find(b => b.text().includes('每日签到'));
    expect(signButton).toBeDefined();

    await signButton!.find('button').trigger('click');
    await flushPromises();

    expect(meSignMock).toHaveBeenCalled();
    expect(wrapper.text()).toContain('签到成功，获得了 35 积分');
  });

  it('shows unverified email alert and sends verification email when requested', async () => {
    sessionUser.value = { ...mockUser, emailVerified: false };
    const wrapper = mountComponent();
    await flushPromises();

    expect(wrapper.text()).toContain('邮箱尚未验证，部分功能可能受限');
    const sendButton = wrapper.findAllComponents(AppButton).find(b => b.text().includes('发送验证邮件'));
    expect(sendButton).toBeDefined();

    await sendButton!.find('button').trigger('click');
    await flushPromises();

    expect(verifyEmailRequestMock).toHaveBeenCalled();
    expect(wrapper.text()).toContain('验证邮件已发送，请检查你的收件箱。');
  });

  it('renders quick shortcuts navigation grid', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    expect(wrapper.text()).toContain('快捷入口');
    expect(wrapper.text()).toContain('角色管理');
    expect(wrapper.text()).toContain('我的衣柜');
    expect(wrapper.text()).toContain('皮肤库');
    expect(wrapper.text()).toContain('上传材质');
    expect(wrapper.text()).toContain('工单');
    expect(wrapper.text()).toContain('投票');
  });

  it('renders Mojang verification and quick launcher setup components', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    expect(wrapper.text()).toContain('正版验证');
    expect(wrapper.text()).toContain('前往验证');
    expect(wrapper.find('[data-test="launcher-setup"]').exists()).toBe(true);
  });

  it('opens score details dialog when clicking score trigger', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const scoreTrigger = wrapper.find('button[title="点击积分查看说明"]');
    expect(scoreTrigger.exists()).toBe(true);
    await scoreTrigger.trigger('click');
    await flushPromises();

    const dialog = wrapper.findComponent(AppDialog);
    expect(dialog.props('modelValue')).toBe(true);
    expect(wrapper.text()).toContain('基础规则');
    expect(wrapper.text()).toContain('积分消耗明细');
  });
});
