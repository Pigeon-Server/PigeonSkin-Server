import { createT, normalizeLocale } from '@pigeon-skin/shared/i18n';
import type { D1Database, Queue } from '@cloudflare/workers-types';
import { translationOverrides } from './translations.ts';
import type { TranslationOverride } from '@pigeon-skin/shared/messages';
import { configurationValues } from './configuration.ts';
// 邮件服务。
//
// 所有外发邮件都经过这里，处理器不直接拼 HTML、也不直接调 HTTP 客户端。
// 传输用 Resend 的 HTTP API（一个普通 fetch，不引 SDK）。
//
// RESEND_API_KEY 只从 Worker Secret 读取，绝不写进源码或日志。

export interface EmailEnv {
  DB?: D1Database;
  RESEND_API_KEY?: string | undefined;
  MAIL_FROM?: string;
  APP_URL?: string;
}

export type EmailTemplate =
  | { kind: 'security-code'; to: string; code: string; locale: string | null }
  | { kind: 'verify-email'; to: string; token: string; locale: string | null }
  | { kind: 'password-reset'; to: string; token: string; locale: string | null }
  | { kind: 'password-changed'; to: string; nickname: string; locale: string | null }
  | { kind: 'email-changed'; to: string; nickname: string; oldEmail: string; newEmail: string; locale: string | null }
  | { kind: 'report-resolved'; to: string; textureName: string; outcome: 'resolved' | 'rejected'; locale: string | null }
  | { kind: 'admin-broadcast'; to: string; title: string; content: string; locale: string | null }
  | { kind: 'ticket-created'; to: string; ticketId: number; ticketNumber: string; title: string; summary: string; locale: string | null }
  | { kind: 'ticket-reply'; to: string; ticketId: number; ticketNumber: string; title: string; summary: string; status: string; locale: string | null }
  | { kind: 'ticket-status'; to: string; ticketId: number; ticketNumber: string; title: string; status: string; locale: string | null };

export interface EmailQueueMessage {
  broadcastId: string;
  receiver: 'all' | 'normal' | number | string;
  title: string;
  content: string;
  afterId: number;
}
export interface EmailQueueEnv { DB: D1Database; EMAIL_NOTIFICATIONS?: Queue<EmailQueueMessage> }

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

/** 把用户内容插进 HTML 前先转义 —— 邮件里的 XSS 同样能钓到用户 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function layout(title: string, bodyHtml: string, appUrl: string, siteName = 'Pigeon Skin Server'): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;
font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#171717">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <h1 style="margin:0 0 16px;font-size:20px">${esc(title)}</h1>
    ${bodyHtml}
    <hr style="margin:32px 0 16px;border:none;border-top:1px solid #e5e5e5">
    <p style="margin:0;font-size:12px;color:#737373">
      <a href="${esc(appUrl)}" style="color:#737373">${esc(siteName)}</a>
    </p>
  </div>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${esc(href)}"
    style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;
    padding:12px 20px;border-radius:8px;font-weight:500">${esc(label)}</a></p>`;
}

export function renderEmail(template: EmailTemplate, appUrl: string, overrides: readonly TranslationOverride[] = []): Rendered {
  const t = createT(normalizeLocale(template.locale || 'en'), overrides);
  function render(title: string, paragraphs: string[], link?: { href: string; label: string }): Rendered {
    const body = paragraphs.map(paragraph => `<p>${esc(paragraph)}</p>`).join('') + (link ? button(link.href, link.label) + `<p>${esc(t('mail.copy_link'))}<br>${esc(link.href)}</p>` : '');
    return { subject: title, html: layout(title, body, appUrl), text: [title, ...paragraphs, ...(link ? [link.label, link.href] : [])].join('\n\n') + '\n' };
  }
  switch (template.kind) {
    case 'security-code':
      return render(t('mail.security_title'), [t('mail.security_body', { code: template.code })]);
    case 'verify-email':
      return render(t('mail.verify_title'), [t('mail.verify_body')], { href: `${appUrl}/verify-email?token=${encodeURIComponent(template.token)}`, label: t('mail.verify_button') });
    case 'password-reset':
      return render(t('mail.reset_title'), [t('mail.reset_body'), t('mail.ignore')], { href: `${appUrl}/reset-password?token=${encodeURIComponent(template.token)}`, label: t('mail.reset_button') });
    case 'password-changed':
      return render(t('mail.password_title'), [t('mail.password_body'), t('mail.password_notice')]);
    case 'email-changed':
      return render(t('mail.email_title'), [t('mail.email_body', { oldEmail: template.oldEmail, newEmail: template.newEmail })]);
    case 'report-resolved':
      return render(t('mail.report_title'), [t('mail.report_body', { name: template.textureName, outcome: t(`mail.${template.outcome}`) })]);
    case 'admin-broadcast':
      return render(template.title, [template.content]);
    case 'ticket-created':
      return render(t('mail.ticket_created_title'), [t('mail.ticket_created_body', { number: template.ticketNumber, title: template.title, summary: template.summary })], { href: `${appUrl}/tickets/${template.ticketId}`, label: t('mail.ticket_view') });
    case 'ticket-reply':
      return render(t('mail.ticket_reply_title'), [t('mail.ticket_reply_body', { number: template.ticketNumber, title: template.title, summary: template.summary })], { href: `${appUrl}/tickets/${template.ticketId}`, label: t('mail.ticket_view') });
    case 'ticket-status':
      return render(t('mail.ticket_status_title'), [t('mail.ticket_status_body', { number: template.ticketNumber, title: template.title, status: template.status })], { href: `${appUrl}/tickets/${template.ticketId}`, label: t('mail.ticket_view') });
  }
}

export interface SendResult {
  ok: boolean;
  /** 未配置密钥时为 'not-configured'，调用方据此决定是否提示用户 */
  reason?: 'not-configured' | 'provider-error';
}

/**
 * 发送邮件。
 *
 * 失败不抛异常：注册或找回密码不该因为邮件服务故障而整体失败。
 * 调用方通过返回值决定是否给用户提示。
 */
export async function sendEmail(env: EmailEnv, template: EmailTemplate, idempotencyKey?: string): Promise<SendResult> {
  const configuration = env.DB
    ? await configurationValues({ DB: env.DB, RESEND_API_KEY: env.RESEND_API_KEY, MAIL_FROM: env.MAIL_FROM, APP_URL: env.APP_URL })
    : { resend_api_key: env.RESEND_API_KEY ?? '', mail_from: env.MAIL_FROM, site_url: env.APP_URL };
  if (!configuration.resend_api_key) return { ok: false, reason: 'not-configured' };

  const overrides = env.DB ? await translationOverrides({ DB: env.DB }, normalizeLocale(template.locale || 'en')) : [];
  const appUrl = (configuration.site_url || env.APP_URL || 'http://localhost:8787').replace(/\/$/, '');
  const { subject, html, text } = renderEmail(template, appUrl, overrides);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configuration.resend_api_key}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: configuration.mail_from,
      to: [template.to],
      subject,
      html,
      text,
      // 自动生成的通知类邮件加这个头，避免被当成人工邮件触发自动回复
      headers: { 'Auto-Submitted': 'auto-generated' },
    }),
  });

  if (!response.ok) {
    // 只记状态码，不记响应体 —— 里面可能带收件人信息
    console.error('Resend 发送失败', response.status);
    return { ok: false, reason: 'provider-error' };
  }
  return { ok: true };
}

export async function enqueueBroadcastEmail(env: EmailQueueEnv, message: EmailQueueMessage): Promise<boolean> {
  const queue = env.EMAIL_NOTIFICATIONS;
  if (!queue) return false;
  await queue.send(message, { contentType: 'json' });
  return true;
}

export async function processBroadcastEmail(env: EmailEnv & EmailQueueEnv, message: EmailQueueMessage): Promise<void> {
  const predicates: string[] = ["role != 'banned'", 'id > ?'];
  const values: (string | number)[] = [message.afterId];
  if (message.receiver === 'normal') predicates.push("role = 'normal'");
  else if (typeof message.receiver === 'number') { predicates.push('id = ?'); values.push(message.receiver); }
  else if (typeof message.receiver === 'string' && message.receiver !== 'all') { predicates.push('email = ? COLLATE NOCASE'); values.push(message.receiver); }
  const rows = await env.DB.prepare(`SELECT id,email,locale FROM users WHERE ${predicates.join(' AND ')} ORDER BY id LIMIT 50`).bind(...values).all<{ id: number; email: string; locale: string | null }>();
  for (const recipient of rows.results) {
    const result = await sendEmail(env, { kind: 'admin-broadcast', to: recipient.email, title: message.title, content: message.content, locale: recipient.locale }, `${message.broadcastId}:${recipient.id}`);
    if (!result.ok) throw new Error(result.reason === 'not-configured' ? 'Email is not configured' : 'Email delivery failed');
  }
  if (rows.results.length === 50) {
    if (!await enqueueBroadcastEmail(env, { ...message, afterId: rows.results.at(-1)!.id })) throw new Error('Email queue unavailable');
  }
}

/** 邮件是否已配置。用于在界面与接口层面提前告知用户。 */
export function isEmailConfigured(env: EmailEnv): boolean {
  return typeof env.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.length > 0;
}
