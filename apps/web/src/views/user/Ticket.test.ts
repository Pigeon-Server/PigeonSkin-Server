// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import UserTicket from '@/views/user/Ticket.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppAlert from '@/components/ui/AppAlert.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppDialog from '@/components/ui/AppDialog.vue';
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
        'ticket.event_status_changed': '工单状态变更为 {status}',
        'ticket.attachments': '附件',
        'ticket.attach_files': '添加附件',
        'ticket.image_preview': '图片预览',
        'ticket.view_image': '查看图片：{name}',
        'ticket.download_original': '下载原图',
        'ticket.file_limit_hint': '支持图片、PDF、文本及 ZIP，单个不超过 5MB',
        'ticket.status.pending': '待处理',
        'ticket.status.in_progress': '处理中',
        'ticket.status.resolved': '已解决',
        'ticket.status.closed': '已关闭',
        'common.retry': '重试',
      };
      const template = messages[key] ?? key;
      if (!params) return template;
      return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
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
    {
      id: 3,
      actorId: 1,
      type: 'message',
      fromStatus: null,
      toStatus: null,
      detail: '这条正文不该被重复成流转记录',
      createdAt: 1710000600,
    },
  ],
};

const getMock = vi.fn().mockResolvedValue(mockDetail);
const replyMock = vi.fn().mockResolvedValue({ ok: true, messageId: 103 });
const { requestBlobMock } = vi.hoisted(() => ({ requestBlobMock: vi.fn() }));

vi.mock('@/api', () => ({
  ticketApi: {
    get: (id: number) => getMock(id),
    reply: (id: number, body: string, files?: File[]) => replyMock(id, body, files),
    attachmentUrl: (ticketId: number, attachmentId: number) => `/api/v1/tickets/${ticketId}/attachments/${attachmentId}`,
  },
  // 附件需要 Bearer 认证：组件经 requestBlob 取 blob 再渲染 object URL
  requestBlob: (path: string) => requestBlobMock(path),
}));

vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:mock-attachment', revokeObjectURL: () => {} }));

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
        AppDialog,
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
    requestBlobMock.mockImplementation(() => Promise.resolve(new Blob(['attachment-bytes'])));
  });

  it('renders ticket header, messages, timeline events and attachments', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    expect(wrapper.text()).toContain('TKT-2026-000010');
    expect(wrapper.text()).toContain('无法同步皮肤材质');
    expect(wrapper.text()).toContain('处理中');
    expect(wrapper.text()).toContain('进入游戏后皮肤显示为默认 Steve');
    expect(wrapper.text()).toContain('请提供一下游戏客户端日志');
    // 图片附件渲染为缩略图 <img>（Bearer 经 requestBlob → object URL）
    const thumbnail = wrapper.find('img[alt="screenshot.png"]');
    expect(thumbnail.exists()).toBe(true);
    expect(thumbnail.attributes('src')).toBe('blob:mock-attachment');
    expect(wrapper.text()).toContain('提交了工单');
    expect(wrapper.text()).toContain('工单状态变更为 处理中');
    // 消息本身已有气泡，事件流不再把正文重复成一条流转记录
    expect(wrapper.text()).not.toContain('这条正文不该被重复成流转记录');
  });

  it('opens the image attachment in a viewer instead of downloading it', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const thumbnail = wrapper.find('button[aria-label="查看图片：screenshot.png"]');
    expect(thumbnail.exists()).toBe(true);
    expect(thumbnail.attributes('download')).toBeUndefined();
    expect(thumbnail.attributes('disabled')).toBeUndefined();
    // 预览弹窗默认关闭，点击缩略图才打开；下载入口在弹窗内
    expect(wrapper.findComponent(AppDialog).props('modelValue')).toBe(false);
    expect(wrapper.find('a[download="screenshot.png"]').exists()).toBe(false);

    await thumbnail.trigger('click');
    await flushPromises();

    const dialog = wrapper.findComponent(AppDialog);
    expect(dialog.props('modelValue')).toBe(true);
    expect(dialog.props('title')).toBe('图片预览');
    const download = dialog.find('a[download="screenshot.png"]');
    expect(download.exists()).toBe(true);
    expect(download.attributes('href')).toBe('blob:mock-attachment');
  });

  it('leaves the viewer closed when the attachment cannot be loaded', async () => {
    requestBlobMock.mockImplementation(() => Promise.reject(new Error('attachment unavailable')));
    const wrapper = mountComponent();
    await flushPromises();

    const thumbnail = wrapper.find('button[aria-label="查看图片：screenshot.png"]');
    expect(thumbnail.attributes('disabled')).toBeDefined();
    expect(thumbnail.text()).toContain('image_not_supported');

    await thumbnail.trigger('click');
    await flushPromises();

    expect(wrapper.findComponent(AppDialog).props('modelValue')).toBe(false);
  });

  it('shows a neutral placeholder while the attachment is still loading', async () => {
    // 永不落地的 promise：模拟慢网下附件仍在读取的窗口
    requestBlobMock.mockImplementation(() => new Promise(() => {}));
    const wrapper = mountComponent();
    await flushPromises();

    const thumbnail = wrapper.find('button[aria-label="查看图片：screenshot.png"]');
    expect(thumbnail.attributes('disabled')).toBeDefined();
    expect(thumbnail.text()).toContain('image');
    expect(thumbnail.text()).not.toContain('image_not_supported');
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
