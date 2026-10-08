// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import UserTicket from '@/views/user/Ticket.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppAlert from '@/components/ui/AppAlert.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: '10' } }),
  RouterLink: {
    props: ['to'],
    template: '<a :href="to"><slot /></a>',
  },
}));

vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    user: {
      value: {
        id: 1,
        nickname: 'Alex',
        avatarTextureId: null,
      },
    },
  }),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'ticket.title': '工单',
        'ticket.reply': '发送回复',
        'ticket.reply_placeholder': '输入回复内容',
        'ticket.you': '我',
        'ticket.support': '支持团队',
        'ticket.admin': '管理员',
        'ticket.back_to_list': '返回工单列表',
        'ticket.event_created': '提交了工单',
        'ticket.attachments': '附件',
        'ticket.attach_files': '添加附件',
        'ticket.file_limit_hint': '支持图片、PDF、文本及 ZIP，单个不超过 5MB',
        'ticket.status.pending': '待处理',
        'ticket.status.in_progress': '处理中',
        'ticket.status.resolved': '已解决',
        'ticket.status.closed': '已关闭',
        'common.retry': '重试',
      };
      if (key === 'ticket.event_status_changed' && params) {
        return `工单状态变更为 ${params.status}`;
      }
      return messages[key] || key;
    },
    d: (d: number | string) => String(d),
  }),
}));

const mockDetail = {
  ticket: {
    id: 10,
    ticketNumber: 'TKT-2026-000010',
    userId: 1,
    title: '无法同步皮肤材质',
    category: 'bug',
    categoryId: 2,
    categoryName: '缺陷反馈',
    description: '进入游戏后皮肤显示为默认 Steve',
    status: 'in_progress' as const,
    createdAt: 1710000000,
    updatedAt: 1710000500,
    closedAt: null,
    userUnread: false,
    adminUnread: false,
  },
  messages: [
    {
      id: 101,
      authorId: 1,
      authorType: 'user' as const,
      authorName: 'Alex',
      body: '进入游戏后皮肤显示为默认 Steve',
      internal: false,
      createdAt: 1710000000,
    },
    {
      id: 102,
      authorId: 99,
      authorType: 'admin' as const,
      authorName: 'SupportTeam',
      body: '请提供一下游戏客户端日志或 CustomSkinLoader.log',
      internal: false,
      createdAt: 1710000500,
    },
  ],
  attachments: [
    {
      id: 501,
      messageId: 101,
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 204800,
    },
  ],
  events: [
    {
      id: 1,
      actorId: 1,
      type: 'created',
      fromStatus: null,
      toStatus: 'pending',
      detail: '缺陷反馈',
      createdAt: 1710000000,
    },
    {
      id: 2,
      actorId: 99,
      type: 'status_changed',
      fromStatus: 'pending',
      toStatus: 'in_progress',
      detail: null,
      createdAt: 1710000500,
    },
  ],
};

const getMock = vi.fn().mockResolvedValue(mockDetail);
const replyMock = vi.fn().mockResolvedValue({ ok: true, messageId: 103 });

vi.mock('@/api', () => ({
  ticketApi: {
    get: (id: number) => getMock(id),
    reply: (id: number, body: string, files?: File[]) => replyMock(id, body, files),
    attachmentUrl: (ticketId: number, attachmentId: number) => `/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
  },
}));

vi.mock('@/components/UserAvatar.vue', () => ({
  default: {
    name: 'UserAvatar',
    props: ['textureId', 'userId', 'name'],
    template: '<div data-test="user-avatar">{{ name }}</div>',
  },
}));

function mountComponent() {
  return mount(UserTicket, {
    global: {
      components: {
        AppButton,
        AppIcon,
        AppAlert,
        AppInput,
        AppSkeleton,
        PageHeader,
        RouterLink: {
          props: ['to'],
          template: '<a :href="to"><slot /></a>',
        },
      },
    },
  });
}

describe('User Ticket Detail View (Ticket.vue)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders ticket header, messages, timeline events and attachments', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    expect(wrapper.text()).toContain('TKT-2026-000010');
    expect(wrapper.text()).toContain('无法同步皮肤材质');
    expect(wrapper.text()).toContain('处理中');
    expect(wrapper.text()).toContain('进入游戏后皮肤显示为默认 Steve');
    expect(wrapper.text()).toContain('请提供一下游戏客户端日志');
    expect(wrapper.text()).toContain('screenshot.png');
    expect(wrapper.text()).toContain('提交了工单');
    expect(wrapper.text()).toContain('工单状态变更为 处理中');
  });

  it('keeps the return link inside the page header as the breadcrumb row', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const header = wrapper.find('header.page-header');
    expect(header.exists()).toBe(true);
    expect(header.find('h1').text()).toBe('TKT-2026-000010');
    const breadcrumb = header.find('nav.page-breadcrumb');
    expect(breadcrumb.exists()).toBe(true);
    expect(breadcrumb.find('a.page-back').attributes('href')).toBe('/tickets');
  });

  it('sends reply successfully and refreshes the timeline', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const textarea = wrapper.findComponent(AppInput).find('textarea');
    await textarea.setValue('已上传日志文件，请查收');

    const replyBtn = wrapper.findAllComponents(AppButton).find(b => b.text().includes('发送回复'));
    expect(replyBtn).toBeDefined();

    await replyBtn!.find('button').trigger('click');
    await flushPromises();

    expect(replyMock).toHaveBeenCalledWith(10, '已上传日志文件，请查收', []);
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
