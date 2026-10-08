// 页面架构契约：应用外壳内的页面共用一个页头组件与一套节奏，内容宽度由框架决定。
// 这里守住契约边界，避免界面再次分叉成多套页头与多种页宽。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const styles = readFileSync(resolve(__dirname, '..', 'styles.css'), 'utf-8');

function cssBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped} \\{([^}]*)\\}`).exec(styles)?.[1] ?? '';
}

function viewFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return viewFiles(full);
    return entry.name.endsWith('.vue') ? [full] : [];
  });
}

// 页面根节点（depth 0）的开标签：宽度上限只允许出现在内容元素上，
// 不允许出现在根节点上，否则页面又会各自框出一套框架宽度。
// 注意：只覆盖根级节点与 max-w-3xl 及以上的命名档位，页面内层元素的
// 阅读宽度（消息气泡、空态卡片等）不在此断言范围内。
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// 根 <template> 块的内部内容：首个 <template> 之后到最后一个 </template>，
// 避免把根 <template> 标签本身算成根节点，也避免被内层 <template #slot> 的闭合标签提前截断。
// 该取法假定 <script>/<style> 里不出现 <template> / </template> 字面量（当前全部视图成立）。
function templateBlock(source: string): string {
  const open = source.indexOf('<template>');
  const end = source.lastIndexOf('</template>');
  const start = open < 0 ? -1 : open + '<template>'.length;
  if (start < 0 || end < start) return '';
  return source.slice(start, end);
}

function rootElements(source: string): string[] {
  const block = templateBlock(source);
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w.-]*)\s*>|<([a-zA-Z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const roots: string[] = [];
  let depth = 0;
  for (let match = token.exec(block); match; match = token.exec(block)) {
    const [, closing, tag, , selfClosing] = match;
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (!tag) continue;
    if (depth === 0) roots.push(match[0]);
    if (selfClosing !== '/' && !VOID_TAGS.has(tag.toLowerCase())) depth += 1;
  }
  return roots;
}

// 返回图标：不同图标库写法都算返回入口。
const BACK_ICONS = new Set(['arrow_back', 'arrow_back_ios', 'chevron_left', 'keyboard_backspace', 'navigate_before', 'west']);

// 落在 .page-back 之外的返回图标（含任意深度）。
function backIconsOutsidePageBack(source: string): string[] {
  const block = templateBlock(source);
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w.-]*)\s*>|<([a-zA-Z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const isPageBack = (text: string) => /\bclass="[^"]*\bpage-back\b/.test(text);
  const openTags: string[] = [];
  const offenders: string[] = [];
  for (let match = token.exec(block); match; match = token.exec(block)) {
    const [, closing, tag, attrs, selfClosing] = match;
    if (closing) {
      openTags.pop();
      continue;
    }
    if (!tag) continue;
    const name = tag.toLowerCase();
    const iconName = /\bname="([^"]*)"/.exec(attrs ?? '')?.[1];
    if (name === 'appicon' && iconName && BACK_ICONS.has(iconName)) {
      if (!isPageBack(match[0]) && !openTags.some(isPageBack)) offenders.push(match[0]);
    }
    if (selfClosing !== '/' && !VOID_TAGS.has(name)) openTags.push(match[0]);
  }
  return offenders;
}

// 自带外壳的页面（认证页、公开首页、手册、404、全屏编辑器）不适用应用外壳页头契约。
const SHELL_LEVEL = /^(auth\/|Home\.vue|HomeClassic\.vue|Manual\.vue|NotFound\.vue|editor\/)/;
// 内容优先的页面：页头由内容自身承担，因此不使用 PageHeader，各自仍只有一个 h1。
//   admin/Index.vue  纯路由中转（只渲染 router-view）
//   skinlib/Show.vue 材质详情：返回行 + 卡片标题构成页头
//   user/Home.vue    创作者主页：头像 + 昵称 + 统计构成身份头
const CONTENT_FIRST = new Set(['skinlib/Show.vue', 'user/Home.vue', 'admin/Index.vue']);

const framePages = viewFiles(__dirname)
  .map((file) => ({
    path: relative(__dirname, file).split('\\').join('/'),
    source: readFileSync(file, 'utf-8'),
  }))
  .filter(({ path }) => !SHELL_LEVEL.test(path));

describe('页面骨架契约', () => {
  it('声明统一的页面节奏与紧凑变体', () => {
    expect(cssBody('.page')).toContain('gap: 20px;');
    expect(cssBody('.page--dense')).toContain('gap: 12px;');
    expect(styles).toContain('.route-page > * + * {');
  });

  it('页头自身不留外边距，节奏只由布局或页面包裹层提供', () => {
    expect(cssBody('.page-header')).toContain('margin-bottom: 0;');
  });

  it('提供紧凑页头与面包屑/返回行的共用样式', () => {
    expect(cssBody('.page-header--dense h1')).toContain('font-size: 21px;');
    expect(styles).toContain('.page-breadcrumb {');
    expect(styles).toContain('.page-back {');
  });

  it('内容区滚动条按固定宽度占位，页面宽度不随内容长短变化', () => {
    expect(styles).toMatch(/\.app-scroll \{[^}]*scrollbar-gutter: stable;/);
  });

  it('应用外壳内的页面都使用统一的页头组件', () => {
    const offenders = framePages
      .filter(({ path, source }) => !CONTENT_FIRST.has(path) && !source.includes('<PageHeader'))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('页面根节点不自设内容宽度上限', () => {
    // 只拦 3xl 及以上的整档内容宽度：max-w-md / max-w-64 这类控件与弹窗宽度不算页面框架。
    const offenders = framePages
      .filter(({ source }) => rootElements(source).some((tag) => /\bmax-w-(3xl|4xl|5xl|6xl|7xl)\b/.test(tag)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('视图里不再残留第二套页头实现', () => {
    const offenders = framePages
      .filter(({ source }) => /resource-(page|heading)/.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('二级页面的返回入口统一用 page-breadcrumb / page-back', () => {
    // 返回图标必须落在 .page-back 内，避免再出现 .btn 形态的第二套返回入口；
    // 不同图标名与不同深度都覆盖，不依赖文件级字符串包含。
    const offenders = framePages
      .filter(({ source }) => backIconsOutsidePageBack(source).length > 0)
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('返回入口始终位于 page-breadcrumb 行内', () => {
    const offenders = framePages
      .filter(({ source }) => source.includes('page-back') && !source.includes('page-breadcrumb'))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
