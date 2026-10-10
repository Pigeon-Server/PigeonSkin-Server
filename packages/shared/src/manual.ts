import { z } from 'zod';
import { LOCALES, type Locale } from './locale.ts';
export const manualGroups = [
  { title: '开始使用', pages: [
    { slug: '', title: '用户使用手册', description: '从第一款皮肤开始，了解账号、角色与游戏配置。' },
    { slug: 'quick-start', title: '新手指引', description: '注册账号、创建角色、挑选材质，轻松进入游戏。' },
    { slug: 'account', title: '账号与邮箱', description: '验证邮箱、找回密码与保护账号。' },
    { slug: 'players', title: '创建与管理角色', description: '了解游戏角色名、皮肤与披风的搭配关系。' },
    { slug: 'textures', title: '上传与设定材质', description: '选择模型类型、上传专属 PNG，为角色换上新装。' },
    { slug: 'closet', title: '我的衣柜', description: '收藏心仪材质，随心为角色搭配皮肤和披风。' },
  ] },
  { title: '在游戏中使用', pages: [
    { slug: 'customskinloader', title: '配置 CustomSkinLoader', description: '下载本站配置，在客户端轻松加载角色材质。' },
    { slug: 'yggdrasil', title: 'Yggdrasil 外置登录', description: '添加认证服务器，使用本站账号登录并挑选角色。' },
    { slug: 'premium', title: '绑定正版角色', description: '通过 Microsoft 账号绑定并保护你的正版角色。' },
  ] },
  { title: '更多功能', pages: [
    { slug: 'score', title: '积分与签到', description: '了解每日签到、积分奖励与站点存储机制。' },
    { slug: 'applications', title: '应用授权', description: '安全确认应用授权请求、设备代码并管理权限。' },
    { slug: 'copyright', title: '创作与举报', description: '尊重原创作者成果，提交版权举报并跟进处理。' },
    { slug: 'advanced-search', title: '高级搜索', description: '用简单的表达式组合字段与逻辑条件，精确筛选搜索结果。' },
  ] },
  { title: '疑难杂症', pages: [
    { slug: 'faq', title: '常见问题', description: '快速排查账号、材质上传、外置登录与游戏内加载问题。' },
    { slug: 'help', title: '寻求帮助', description: '整理关键排障信息，让管理员更快协助你解决问题。' },
  ] },
];
export const manualPages = manualGroups.flatMap(group => group.pages.map(page => ({ ...page, group: group.title })));
export function localizedManualPages(t: (key: string) => string) {
  const groupKeys = ['start', 'game', 'more', 'help'];
  return manualGroups.flatMap((group, index) => group.pages.map(page => ({
    ...page,
    title: t(`manual.pages.${page.slug || 'welcome'}.title`),
    description: t(`manual.pages.${page.slug || 'welcome'}.description`),
    group: t(`manual.groups.${groupKeys[index]}`),
  })));
}
export const manualDocumentInput = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  content: z.string().max(200_000),
  group: z.string().trim().min(1).max(80).optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ManualDocumentInput = z.infer<typeof manualDocumentInput>;
export interface ManualDocument {
  locale?: Locale;
  availableLocales?: readonly Locale[];
  slug: string;
  title: string;
  description: string;
  content: string;
  updatedAt: number;
  group?: string;
}
export function resolveManualDocuments(documents: readonly ManualDocument[], locale: Locale): ManualDocument[] {
  const result = new Map<string, ManualDocument>();
  for (const document of documents) if (document.locale === 'en') result.set(document.slug, document);
  for (const document of documents) if ((document.locale || 'zh_CN') === locale) result.set(document.slug, document);
  return [...result.values()].map(document => ({ ...document, availableLocales: manualPages.some(page => page.slug === document.slug) || documents.some(item => item.slug === document.slug && item.locale === 'en') ? LOCALES : [...new Set(documents.filter(item => item.slug === document.slug).map(item => item.locale || 'zh_CN'))] }));
}
export function validManualSlug(value: string) { return value === '' || (value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value !== 'welcome'); }
export function manualSiteUrl(configured: string, fallback: string) {
  for (const value of [configured, fallback]) {
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.origin;
    } catch { continue; }
  }
  return '';
}
export function renderManualContent(content: string, siteUrl: string, siteName = '') {
  return content.replaceAll('{{site_url}}', siteUrl).replaceAll('{{origin}}', siteUrl).replaceAll('{{site_name}}', siteName);
}
export interface ManualAsset {
  id: string;
  name: string;
  kind: 'image' | 'audio' | 'video';
  mime: string;
  size: number;
  url: string;
  uploadedAt: number;
  builtin?: boolean;
  usedBy?: string[];
}
export const MANUAL_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const MANUAL_ASSET_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.mp3,.wav,.ogg,.flac,.m4a,.mp4,.webm,.weba';
export const manualBuiltinAssets: ManualAsset[] = [
  ['players', '角色管理'], ['skinlib', '皮肤库'], ['upload', '上传材质'], ['closet', '我的衣柜'],
  ['customskinloader', '配置生成器'], ['texture-detail', '材质详情'], ['apply-texture', '应用到角色'],
].map(([id, name]) => ({ id: `builtin-${id}`, name: `${name}.jpg`, kind: 'image', mime: 'image/jpeg', size: 0, url: `/manual/${id}.jpg`, uploadedAt: 0, builtin: true }));
export function manualAssetMarkdown(asset: ManualAsset) {
  const label = asset.name.replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&');
  if (asset.kind === 'image') return `![${label}](${asset.url})`;
  const name = asset.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<${asset.kind} controls preload="metadata" src="${asset.url}" aria-label="${name}"></${asset.kind}>\n\n[${label}](${asset.url})`;
}
