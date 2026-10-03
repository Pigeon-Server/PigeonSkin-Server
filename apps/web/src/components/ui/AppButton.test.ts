import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import AppButton from '@/components/ui/AppButton.vue';
describe('AppButton', () => {
  it('preserves native submit and reset semantics', async () => {
    for (const type of ['button', 'submit', 'reset'] as const) {
      const html = await renderToString(createSSRApp({ render: () => h(AppButton, { type }, () => 'Action') }));
      expect(html).toContain(`type="${type}"`);
    }
  });
  it('disables a loading action', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(AppButton, { type: 'submit', loading: true }, () => 'Action') }));
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('aria-busy="true"');
  });
});
