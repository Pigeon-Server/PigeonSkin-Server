import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import TextureCard from '@/components/TextureCard.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import type { TextureSummary } from '@/api';

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        'general.skin': '皮肤',
        'general.cape': '披风',
        'skinlib.model_classic': 'Steve · 标准',
        'skinlib.model_slim': 'Alex · 纤细',
        'skinlib.official_resource': 'Mojang 官方',
        'skinlib.origin_repost': '转载',
        'skinlib.origin_original': '原创',
        'skinlib.private': '私密',
        'skinlib.addToCloset': '添加至衣柜',
        'skinlib.removeFromCloset': '从衣柜中移除',
      };
      return messages[key] || key;
    },
    n: (num: number) => String(num),
  }),
}));

function createTestCardApp(props: {
  texture: TextureSummary;
  collected?: boolean;
  busy?: boolean;
}) {
  const app = createSSRApp({
    render: () => h(TextureCard, props),
  });
  app.component('AppButton', AppButton);
  app.component('AppIcon', AppIcon);
  app.component('router-link', {
    props: ['to'],
    template: '<a :href="to"><slot /></a>',
  });
  return app;
}

const mockSkin: TextureSummary = {
  id: 101,
  hash: 'abc123456789',
  kind: 'skin',
  model: 'default',
  name: 'Diamond Knight',
  official: false,
  visibility: 'public',
  width: 64,
  height: 64,
  sizeBytes: 2048,
  likes: 42,
  uploaderId: 7,
  uploaderName: 'CraftMaster',
  sourceResourceId: null,
  origin: 'original',
  sourceResourceName: null,
  createdAt: 1700000000,
};

describe('TextureCard', () => {
  it('renders texture metadata and title', async () => {
    const html = await renderToString(createTestCardApp({ texture: mockSkin }));
    expect(html).toContain('Diamond Knight');
    expect(html).toContain('CraftMaster');
    expect(html).toContain('/skinlib/101');
    expect(html).toContain('42');
  });

  it('renders lock icon when texture is private', async () => {
    const privateSkin: TextureSummary = { ...mockSkin, visibility: 'private' };
    const html = await renderToString(createTestCardApp({ texture: privateSkin }));
    expect(html).toContain('title="私密"');
    expect(html).toContain('>lock</span>');
  });

  it('renders official badge when texture is official', async () => {
    const officialSkin: TextureSummary = { ...mockSkin, official: true, uploaderName: null };
    const html = await renderToString(createTestCardApp({ texture: officialSkin }));
    expect(html).toContain('Mojang 官方');
  });

  it('reflects collected state in button classes', async () => {
    const html = await renderToString(
      createTestCardApp({ texture: mockSkin, collected: true }),
    );
    expect(html).toContain('!text-rose-500');
    expect(html).toContain('>favorite</span>');
  });
});
