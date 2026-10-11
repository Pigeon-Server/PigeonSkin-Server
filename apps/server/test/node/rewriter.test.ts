// HTMLRewriter 子集测试：复刻 seo.ts renderSearchPage 的注入场景。

import { describe, expect, it } from 'vitest';
import { NodeHTMLRewriter } from '../../src/node/rewriter.ts';

const SPA_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pigeon Skin</title></head><body><div id="app"></div><script src="/assets/main.js"></script></body></html>`;

describe('NodeHTMLRewriter', () => {
  it('复刻 renderSearchPage 场景：html lang、title、head 注入、#app 替换', async () => {
    const tags = '<link rel="canonical" href="https://site.test/skinlib/1"><meta name="robots" content="index,follow">';
    const content = '<main><h1>苦力怕皮肤</h1></main>';

    const response = new NodeHTMLRewriter()
      .on('html', { element(element) { element.setAttribute('lang', 'zh-CN'); } })
      .on('title', { element(element) { element.setInnerContent('苦力怕皮肤 · Pigeon Skin'); } })
      .on('head', { element(element) { element.append(tags, { html: true }); } })
      .on('#app', { element(element) { element.setInnerContent(content, { html: true }); } })
      .transform(new Response(SPA_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<title>苦力怕皮肤 · Pigeon Skin</title>');
    expect(html).toContain(tags);
    // #app 的空内容被替换为预渲染正文
    expect(html).toContain(`<div id="app">${content}</div>`);
    // 原有节点不受影响
    expect(html).toContain('<script src="/assets/main.js"></script>');
    expect(html).toContain('<meta charset="utf-8">');
  });

  it('setInnerContent 不带 html 选项时按文本转义（Workers 语义）', async () => {
    const response = new NodeHTMLRewriter()
      .on('title', { element(element) { element.setInnerContent('a<b>&"c'); } })
      .transform(new Response(SPA_HTML));
    const html = await response.text();
    expect(html).toContain('<title>a&lt;b&gt;&amp;"c</title>');
    expect(html).not.toContain('<title>a<b>');
  });

  it('append 不带 html 选项时按文本追加', async () => {
    const response = new NodeHTMLRewriter()
      .on('head', { element(element) { element.append('<meta name="x" content="y">'); } })
      .transform(new Response(SPA_HTML));
    const html = await response.text();
    expect(html).toContain('&lt;meta name="x" content="y"&gt;');
  });

  it('选择器无匹配时不报错', async () => {
    const response = new NodeHTMLRewriter()
      .on('#nope', { element(element) { element.setAttribute('x', 'y'); } })
      .on('footer', { element() { throw new Error('不该被调用'); } })
      .transform(new Response(SPA_HTML));
    expect(await response.text()).toContain(SPA_HTML.replace('<!doctype html>', ''));
  });

  it('不支持的复杂选择器显式报错（防止业务悄悄依赖未实现能力）', async () => {
    // 改写在 transform 返回的 body 流里进行，错误以 rejected body 形式浮出
    const response = new NodeHTMLRewriter().on('div.cls', { element() {} }).transform(new Response(SPA_HTML));
    await expect(response.text()).rejects.toThrow(/不支持选择器/);
  });
});
