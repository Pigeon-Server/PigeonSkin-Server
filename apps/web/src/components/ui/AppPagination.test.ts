import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import AppPagination from '@/components/ui/AppPagination.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'common.page_of' && params) {
        return `第 ${params.page} 页 / 共 ${params.total} 页`;
      }
      if (key === 'common.prev') return '上一页';
      if (key === 'common.next') return '下一页';
      return key;
    },
    n: (num: number) => String(num),
  }),
}));

function createTestApp(props: Record<string, unknown>) {
  const app = createSSRApp({
    render: () => h(AppPagination, props as any),
  });
  app.component('AppButton', AppButton);
  app.component('AppIcon', AppIcon);
  return app;
}

describe('AppPagination', () => {
  it('does not render when totalPages is 1 or less', async () => {
    const html = await renderToString(createTestApp({ modelValue: 1, totalPages: 1 }));
    expect(html).toBe('<!---->');
  });

  it('renders standard compact controls by default', async () => {
    const html = await renderToString(createTestApp({ modelValue: 2, totalPages: 5 }));
    expect(html).toContain('pagination-controls');
    expect(html).not.toContain('pagination-pages');
    expect(html).toContain('pagination-summary');
  });

  it('renders page number buttons when showPages is true', async () => {
    const html = await renderToString(
      createTestApp({ modelValue: 5, totalPages: 10, showPages: true }),
    );
    expect(html).toContain('pagination-pages');
    expect(html).toContain('pagination-page-btn');
    expect(html).toContain('pagination-ellipsis');
    expect(html).toContain('aria-current="page"');
  });
});
