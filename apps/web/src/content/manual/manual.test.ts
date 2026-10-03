import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manualPages, manualContent, manualSections, searchManual } from './index';
import { manualSiteUrl, renderManualContent, manualAssetMarkdown } from '@pigeon-skin/shared/manual';

describe('用户手册', () => {
  it('生成图片、音频和视频的正确引用，转义文件名称', () => {
    const asset = { id: 'id', name: '说明[图].png', kind: 'image' as const, mime: 'image/png', size: 1, url: '/api/v1/manual/assets/id.png', uploadedAt: 1 };
    expect(manualAssetMarkdown(asset)).toBe('![说明\\[图\\].png](/api/v1/manual/assets/id.png)');
    expect(manualAssetMarkdown({ ...asset, kind: 'audio', name: '提示"音.wav' })).toContain('<audio controls preload="metadata"');
    expect(manualAssetMarkdown({ ...asset, kind: 'video' })).toContain('<video controls preload="metadata"');
    expect(manualAssetMarkdown({ ...asset, kind: 'audio', name: '提示"音.wav' })).toContain('&quot;');
  });
  it('从配置地址替换新旧站点变量，并拒绝非 HTTP 地址', () => {
    const root = manualSiteUrl('https://skin.example.com/', 'http://localhost:5173');
    expect(root).toBe('https://skin.example.com');
    expect(renderManualContent('`{{site_url}}/api/yggdrasil` [站点]({{origin}}) {{site_name}}', root, '皮肤站')).toBe('`https://skin.example.com/api/yggdrasil` [站点](https://skin.example.com) 皮肤站');
    expect(manualSiteUrl('javascript:alert(1)', 'http://localhost:5173')).toBe('http://localhost:5173');
  });
  it('目录识别 Markdown 标题，不将代码块中的标题拆成章节', () => {
    const sections = manualSections('介绍\n\n```md\n## 示例\n```\n\n## **配置** [客户端](/user/config)\n\n步骤');
    expect(sections).toHaveLength(2);
    expect(sections[0]!.content).toContain('## 示例');
    expect(sections[1]).toEqual({ id: 'section-1', title: '配置 客户端', content: '步骤' });
  });
  it('每篇文档都有正文，所有章节链接和配图均可访问', () => {
    for (const page of manualPages) {
      const content = manualContent(page.slug);
      expect(content.trim(), page.title).not.toBe('');
      for (const link of content.matchAll(/\]\(\/manual(?:\/([^\s)#]+))?(?:#([^\s)]+))?\)/g)) {
        const slug = link[1] || '';
        if (slug.endsWith('.jpg')) {
          expect(existsSync(fileURLToPath(new URL(`../../../public/manual/${slug}`, import.meta.url))), slug).toBe(true);
        } else {
          expect(manualPages.some(item => item.slug === slug), slug).toBe(true);
          if (link[2]) expect(manualSections(manualContent(slug)).some(section => section.id === link[2]), link[0]).toBe(true);
        }
      }
    }
  });

  it('可按正文关键词搜索，并同时匹配多个关键词', () => {
    expect(searchManual('  extralist  ').map(page => page.slug)).toContain('customskinloader');
    expect(searchManual('Steve Alex').map(page => page.slug)).toContain('textures');
    expect(searchManual('不存在的检索词')).toEqual([]);
    expect(searchManual('   ')).toEqual([]);
  });
});
