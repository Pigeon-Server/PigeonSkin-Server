// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import AdminTextures from '@/views/admin/Textures.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import SearchExpressionField from '@/components/search/SearchExpressionField.vue';
import type { AdminTextureRow } from '@/api';

const mockTextures = vi.fn();

vi.mock('@/api', () => ({
  adminApi: {
    textures: (...args: unknown[]) => mockTextures(...args),
    deleteTexture: vi.fn(),
    patchTexture: vi.fn(),
  },
  avatarUrl: (hash: string) => `/avatar/${hash}`,
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
      };
      return messages[key] ?? key;
    },
    n: (v: number) => String(v),
  }),
}));

function row(overrides: Partial<AdminTextureRow>): AdminTextureRow {
  return {
    id: 1,
    hash: 'a'.repeat(64),
    name: 'Test Skin',
    kind: 'skin',
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

function createWrapper() {
  return mount(AdminTextures, {
    global: {
      components: { AppButton, AppIcon, AppInput, AppSkeleton, PageHeader, SearchExpressionField },
      stubs: { 'router-link': { template: '<a><slot /></a>' } },
    },
  });
}

describe('AdminTextures View', () => {
  it('renders official textures as 官方资源 instead of 已注销 in uploader column', async () => {
    mockTextures.mockResolvedValue({
      items: [
        row({ id: 101, official: true, uploaderId: null, uploaderName: null }),
        row({ id: 102, official: false }),
        row({ id: 103, official: false, uploaderId: null, uploaderName: null }),
      ],
      totalPages: 1,
    });
    const wrapper = createWrapper();
    await flushPromises();
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
});
