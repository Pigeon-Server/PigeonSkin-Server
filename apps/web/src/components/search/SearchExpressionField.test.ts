import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';

// SSR 测试环境没有 DOM：mock 掉 i18n store，只保留组件用到的 t()。
vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, n: (value: number) => String(value), locale: { value: 'zh_CN' } }),
}));

const { default: SearchExpressionField } = await import('@/components/search/SearchExpressionField.vue');

const render = (props: Record<string, unknown> = {}) =>
  renderToString(createSSRApp({ render: () => h(SearchExpressionField, { schemaKey: 'textures', modelValue: '', ...props }) }));

describe('SearchExpressionField', () => {
  it('keeps layout classes on the wrapper and forwards input attributes to the input', async () => {
    const html = await render({ class: 'max-w-sm', disabled: true, placeholder: '搜索' });
    // class 决定容器的布局尺寸，不能被透传吞掉
    expect(html).toMatch(/class="search-expression[^"]*max-w-sm/);
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toContain('placeholder="搜索"');
    // 上限来自共享的语法限制，避免用户写出必然被拒绝的超长表达式
    expect(html).toContain('maxlength="500"');
  });

  it('never blocks the user with validation output', async () => {
    // 解析不了的输入按普通词处理，因此组件不渲染任何错误提示
    for (const value of ['kind:skin', 'kind:furniture', 'nope:1', '..', '"未闭合']) {
      const html = await render({ modelValue: value });
      expect(html, value).not.toContain('role="alert"');
      expect(html, value).not.toContain('aria-invalid');
    }
  });

  it('renders the advanced search trigger next to the input', async () => {
    const html = await render();
    expect(html).toContain('search-expression');
    expect(html).toContain('btn-icon');
  });
});
