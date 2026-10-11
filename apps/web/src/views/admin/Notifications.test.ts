// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminNotifications from '@/views/admin/Notifications.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppForm from '@/components/ui/AppForm.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import MarkdownContent from '@/components/ui/MarkdownContent.vue';

const mockBroadcast = vi.fn();
const mockEmailPreview = vi.fn();
const mockAuditLog = vi.fn();
const mockConfirmAction = vi.fn().mockResolvedValue(true);

vi.mock('@/api', () => ({
  adminApi: {
    broadcast: (...args: unknown[]) => mockBroadcast(...args),
    notificationEmailPreview: (...args: unknown[]) => mockEmailPreview(...args),
    auditLog: (...args: unknown[]) => mockAuditLog(...args),
  },
  ApiError: class ApiError extends Error {
    fields?: Record<string, string> | undefined;
    constructor(msg: string, fields?: Record<string, string>) {
      super(msg);
      this.fields = fields;
    }
  },
}));

vi.mock('@/stores/dialog', () => ({
  confirmAction: (...args: unknown[]) => mockConfirmAction(...args),
}));

vi.mock('@/stores/site', () => ({
  useSiteSettings: () => ({
    get: (key: string) => (key === 'site_name' ? 'Test Skin Site' : ''),
  }),
}));

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    locale: { value: 'zh_CN' },
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'admin.broadcast_confirm_user') return `确定向用户 ${params?.target} 发送此通知吗？`;
      if (key === 'admin.notification_sent') return `已发送至 ${params?.count} 位用户`;
      if (key === 'admin.broadcast_sent_count') return `成功送达 ${params?.count} 人`;
      return key;
    },
    n: (v: number) => String(v),
    d: (v: number | string) => String(v),
  }),
}));

function createWrapper() {
  return mount(AdminNotifications, {
    global: {
      components: {
        AppButton,
        AppIcon,
        AppInput,
        AppSelect,
        AppCheckbox,
        AppForm,
        AppSkeleton,
        PageHeader,
        MarkdownContent,
      },
      stubs: {
        'router-link': { template: '<a><slot /></a>' },
      },
    },
  });
}

describe('AdminNotifications View', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBroadcast.mockResolvedValue({ sent: 1, emailQueued: false });
    mockEmailPreview.mockResolvedValue({ subject: 'Test Subject', html: '<p>Test</p>', text: 'Test' });
    mockAuditLog.mockResolvedValue({
      items: [
        {
          id: 1,
          actorId: 1,
          action: 'admin.broadcast',
          targetType: null,
          targetId: null,
          detail: 'receiver:all,sent:42,emailQueued:true',
          createdAt: Date.now(),
        },
      ],
      total: 1,
    });
  });

  it('renders compose form, live preview panel, and broadcast history', async () => {
    const wrapper = createWrapper();
    await flushPromises();

    expect(wrapper.find('h1').text()).toContain('admin.broadcast');
    expect(wrapper.find('#notif-title').exists()).toBe(true);
    expect(wrapper.find('#notif-content').exists()).toBe(true);
    // Variable insertion chips are rendered
    expect(wrapper.text()).toContain('{{site_name}}');
    expect(wrapper.text()).toContain('{{player}}');
    // History row is rendered
    expect(wrapper.text()).toContain('成功送达 42 人');
  });

  it('toggles recipient input when target is user', async () => {
    const wrapper = createWrapper();

    expect(wrapper.find('#notif-recipient').exists()).toBe(false);

    // Switch target to user
    const select = wrapper.findComponent(AppSelect);
    select.vm.$emit('update:modelValue', 'user');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('#notif-recipient').exists()).toBe(true);
  });

  it('inserts variable token into textarea when chip is clicked', async () => {
    const wrapper = createWrapper();

    const textarea = wrapper.find('textarea#notif-content');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('');

    // Click variable chip for player
    const chips = wrapper.findAll('button[type="button"]');
    const playerChip = chips.find(c => c.text().includes('{{player}}'));
    expect(playerChip).toBeDefined();
    await playerChip!.trigger('click');
    await wrapper.vm.$nextTick();

    expect((textarea.element as HTMLTextAreaElement).value).toContain('{{player}}');
  });

  it('sends broadcast with confirmed payload and displays notice', async () => {
    const wrapper = createWrapper();

    // Enter title & content
    const titleInput = wrapper.findComponent(AppInput);
    await titleInput.setValue('System Update');
    const textarea = wrapper.find('textarea#notif-content');
    await textarea.setValue('Hello {{player}}');

    // Submit form
    const form = wrapper.find('form');
    await form.trigger('submit');
    await flushPromises();

    expect(mockConfirmAction).toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith({
      title: 'System Update',
      content: 'Hello {{player}}',
      receiver: 'all',
      sendEmail: false,
    });
    expect(wrapper.text()).toContain('已发送至 1 位用户');
  });
});
