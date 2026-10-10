// 站内信模板变量。
//
// 管理员在群发通知里写 {{site_name}}、{{player}} 这样的占位符，发送时按
// 收件人逐个替换。变量集刻意保持小而稳定：全部来自站点设置与收件人自身，
// 不引入需要用户授权或跨服务查询的数据。
//
// 渲染发生在写入之前（broadcast 入口对每个收件人渲染一次），因此 AI 翻译
// 拿到的已经是含具体值的成品文本 —— 译文按 (通知, 语言) 缓存才有可能。
//
// 未知变量原样保留：宁可让用户看见 {{typo}} 也不静默吞掉内容。

/** 变量名 → 说明（i18n 键后缀，管理界面展示用） */
export const NOTIFICATION_VARIABLES = [
  'site_name',
  'site_url',
  'player',
  'email',
  'uid',
  'score',
  'date',
] as const;

export type NotificationVariable = (typeof NOTIFICATION_VARIABLES)[number];

export interface NotificationTemplateContext {
  siteName: string;
  siteUrl: string;
  /** 收件人角色名；无角色语境（按邮箱/全体发送时逐行取得）可为空串 */
  player: string;
  email: string;
  uid: number;
  /** 收件人当前积分 */
  score: number;
}

/** 日期统一按收件人不可见的服务端时区渲染成 yyyy-MM-dd，避免逐语言本地化分歧 */
function formatDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function renderNotificationTemplate(template: string, context: NotificationTemplateContext, now = Date.now()): string {
  const values: Record<NotificationVariable, string> = {
    site_name: context.siteName,
    site_url: context.siteUrl,
    player: context.player,
    email: context.email,
    uid: String(context.uid),
    score: String(context.score),
    date: formatDate(now),
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? values[name as NotificationVariable]! : match,
  );
}

/** 提取模板里实际用到的变量名（含未知变量），供预览与测试提示 */
export function extractTemplateVariables(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map(m => m[1]!);
}
