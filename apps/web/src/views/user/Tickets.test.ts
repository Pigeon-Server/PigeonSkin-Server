// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import UserTickets from '@/views/user/Tickets.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppAlert from '@/components/ui/AppAlert.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import PageHeader from '@/components/ui/PageHeader.vue';

const mockPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useRoute: () => ({ params: {} }),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        'ticket.title': '工单',
        'ticket.unread': '未读',
        'ticket.create': '提交工单',
        'ticket.subject': '标题',
        'ticket.category_label': '分类',
        'ticket.description': '请描述遇到的问题',
        'ticket.attachments': '附件',
        'ticket.attach_files': '添加附件',
        'ticket.file_limit_hint': '支持图片、PDF、文本及 ZIP，单个不超过 5MB',
        'ticket.submit': '提交',
        'ticket.created': '工单已提交',
        'ticket.empty': '暂无工单',
        'ticket.select_category': '请选择工单分类',
        'ticket.status.pending': '待处理',
        'ticket.status.in_progress': '处理中',
        'ticket.status.resolved': '已解决',
        'ticket.status.closed': '已关闭',
        'common.retry': '重试',
      };
      return messages[key] || key;
    },
    d: (d: number | string) => String(d),
  }),
}));

const mockCategories = {
  items: [
    { id: 1, slug: 'account', name: '账号问题', hidden: false, sortOrder: 0, createdAt: 1, updatedAt: 1 },
    { id: 2, slug: 'bug', name: '缺陷反馈', hidden: false, sortOrder: 1, createdAt: 1, updatedAt: 1 },
  ],
};

const mockTickets = {
  items: [
    {
      id: 10,
      ticketNumber: 'TKT-2026-000010',
      userId: 1,
      title: '无法同步皮肤材质',
      category: 'bug',
      categoryId: 2,
      categoryName: '缺陷反馈',
      description: '进入游戏后皮肤显示为默认 Steve',
      status: 'pending' as const,
      createdAt: 1710000000,
      updatedAt: 1710000000,
      closedAt: null,
      userUnread: true,
      adminUnread: false,
    },
  ],
  unread: 1,
};

const categoriesMock = vi.fn().mockResolvedValue(mockCategories);
const listMock = vi.fn().mockResolvedValue(mockTickets);
const createMock = vi.fn().mockResolvedValue({ id: 11, ticketNumber: 'TKT-2026-000011' });

vi.mock('@/api', () => ({
  ticketApi: {
    categories: () => categoriesMock(),
    list: () => listMock(),
    create: (input: unknown) => createMock(input),
  },
}));

function mountComponent() {
  return mount(UserTickets, {
    global: {
      components: {
        AppButton,
        AppIcon,
        AppAlert,
        AppInput,
        AppSelect,
        AppSkeleton,
        EmptyState,
        PageHeader,
      },
    },
  });
}

describe('User Tickets View (Tickets.vue)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders ticket list with status badge, category and unread alert', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    expect(wrapper.text()).toContain('工单');
    expect(wrapper.text()).toContain('TKT-2026-000010');
    expect(wrapper.text()).toContain('无法同步皮肤材质');
    expect(wrapper.text()).toContain('缺陷反馈');
    expect(wrapper.text()).toContain('待处理');
    expect(wrapper.text()).toContain('未读');
  });

  it('submits a new ticket and navigates to the ticket detail page', async () => {
    const wrapper = mountComponent();
    await flushPromises();

    const titleInput = wrapper.findAllComponents(AppInput)[0]!;
    await titleInput.find('input').setValue('全新反馈');

    const descInput = wrapper.findAllComponents(AppInput)[1]!;
    await descInput.find('textarea').setValue('详细问题描述内容');

    const submitBtn = wrapper.findAllComponents(AppButton).find(b => b.text().includes('提交'));
    expect(submitBtn).toBeDefined();

    await submitBtn!.find('button').trigger('click');
    await flushPromises();

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '全新反馈',
        description: '详细问题描述内容',
        categoryId: 1,
      }),
    );
    expect(mockPush).toHaveBeenCalledWith('/tickets/11');
  });
});
