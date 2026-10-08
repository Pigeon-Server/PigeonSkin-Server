// Workers HTMLRewriter 的 Node 侧子集实现，基于 linkedom。
//
// 业务代码只有一处用法（seo.ts renderSearchPage）：
//   new HTMLRewriter()
//     .on('html',  { element(el) { el.setAttribute('lang', …) } })
//     .on('title', { element(el) { el.setInnerContent(…) } })          // 文本语义
//     .on('head',  { element(el) { el.append(tags, { html: true }) } })
//     .on('#app',  { element(el) { el.setInnerContent(content, { html: true }) } })
//     .transform(response)
//
// 因此只实现这个子集：选择器支持标签名与 #id；element 回调支持
// setAttribute / setInnerContent / append。Workers 的 comment/text 回调、
// onDocument、end 写出等业务未用到，刻意不做——不实现的成员在类型层
// 直接报错，防止业务代码悄悄长出 Node 跑不了的能力。
//
// 语义对齐说明：Workers setInnerContent/append 默认按文本处理（HTML
// 转义），传 { html: true } 才按标记解析。linkedom 侧用 textContent /
// innerHTML 分别对应这两种语义。Workers 是流式改写，这里是解析-改写-
// 序列化，对 index.html 体量的输入没有实质差异。

import { parseHTML } from 'linkedom';

/** 传给 element 回调的包装对象（对齐 Workers ElementHandler 用到的子集） */
export interface RewriterElement {
  setAttribute(name: string, value: string): void;
  setInnerContent(content: string, options?: { html?: boolean | undefined }): void;
  append(content: string, options?: { html?: boolean | undefined }): void;
}

export interface ElementHandlers {
  element(element: RewriterElement): void;
}

interface Registration {
  selector: string;
  handlers: ElementHandlers;
}

export class NodeHTMLRewriter {
  readonly #registrations: Registration[] = [];

  on(selector: string, handlers: ElementHandlers): this {
    this.#registrations.push({ selector, handlers });
    return this;
  }

  transform(response: Response): Response {
    // 注册规则在 transform 调用时才应用（Workers 同样是 transform 触发）
    const registrations = this.#registrations.slice();
    // Workers 的 transform 返回的 Response body 是流式异步产出；Node 侧
    // 的 Response 构造器只接受同步 body，这里用一个"已 settle 后再读"
    // 的 ReadableStream 等价物——直接返回新 Promise 化的 Response 是
    // 不行的，因此先同步建 Response，body 用流异步写入。
    const out = new TransformStream<Uint8Array, Uint8Array>();
    const result = new Response(out.readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    void (async () => {
      const writer = out.writable.getWriter();
      try {
        const html = await response.text();
        const rewritten = rewriteHtml(html, registrations);
        await writer.write(new TextEncoder().encode(rewritten));
        await writer.close();
      } catch (error) {
        // 改写失败以 rejected 流的形式浮出（Workers 的 transform 同样是
        // 消费 body 时才抛错）
        await writer.abort(error);
      }
    })();
    return result;
  }
}

function rewriteHtml(html: string, registrations: Registration[]): string {
  const { document } = parseHTML(html);
  for (const { selector, handlers } of registrations) {
    for (const node of matchSelectors(document, selector)) {
      handlers.element(wrapElement(node));
    }
  }
  return document.toString();
}

type LinkedomElement = {
  setAttribute(name: string, value: string): void;
  get textContent(): string;
  set textContent(value: string);
  get innerHTML(): string;
  set innerHTML(value: string);
  append(...nodes: unknown[]): void;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);
}

/** 只支持业务用到的选择器：标签名与 #id（组合选择器报错而非静默跳过） */
function matchSelectors(document: ReturnType<typeof parseHTML>['document'], selector: string): LinkedomElement[] {
  if (/^[a-zA-Z][\w-]*$/.test(selector)) {
    if (selector.toLowerCase() === 'html') {
      const root = document.documentElement;
      return root ? [root as unknown as LinkedomElement] : [];
    }
    return [...document.querySelectorAll(selector)] as unknown as LinkedomElement[];
  }
  if (/^#[\w-]+$/.test(selector)) {
    const found = document.querySelector(selector);
    return found ? [found as unknown as LinkedomElement] : [];
  }
  throw new Error(`NodeHTMLRewriter 不支持选择器：${selector}（只实现标签名与 #id）`);
}

function wrapElement(node: LinkedomElement): RewriterElement {
  return {
    setAttribute: (name, value) => node.setAttribute(name, value),
    setInnerContent: (content, options) => {
      if (options?.html) node.innerHTML = content;
      // linkedom 对 <title> 这类 raw text 元素的 textContent 不做转义
      // 序列化（与 Workers 的"文本语义"不符），这里手动转义后直写；
      // 普通元素的 textContent 序列化时会再转义一次，但业务只在
      // <title> 上用文本语义，两种路径经同一 escapeHtml 保持一致
      else node.textContent = escapeHtml(content);
    },
    append: (content, options) => {
      if (options?.html) node.innerHTML += content;
      else node.append(content);
    },
  };
}


