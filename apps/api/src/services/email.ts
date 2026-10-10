import { createT, normalizeLocale } from '@pigeon-skin/shared/i18n';
import { noCaseEq } from '@pigeon-skin/db';
import type { D1Database, Queue } from '@cloudflare/workers-types';
import { translationOverrides } from './translations.ts';
import type { TranslationOverride } from '@pigeon-skin/shared/messages';
import { configurationValues, type ConfigurationSourceEnv } from './configuration.ts';
import { sendViaSmtp, SmtpError, parseAddress, type SmtpEncryption, type SmtpOptions } from './smtp.ts';
// 邮件服务。
//
// 所有外发邮件都经过这里，处理器不直接拼 HTML、也不直接调 HTTP 客户端。
// 传输按 mail_driver 分发：resend 走 HTTP API（普通 fetch，不引 SDK），
// smtp 直连任意 SMTP 服务器（cloudflare:sockets，见 smtp.ts）。
//
// 凭据只从 Worker Secret 或超管设置读，绝不写进源码或日志。

export interface EmailEnv {
  DB?: D1Database;
  RESEND_API_KEY?: string | undefined;
  MAIL_DRIVER?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_ENCRYPTION?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
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
  | { kind: 'ticket-status'; to: string; ticketId: number; ticketNumber: string; title: string; status: string; locale: string | null }
  | { kind: 'test-mail'; to: string; locale: string | null };

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
    case 'test-mail':
      return render(t('mail.test_title'), [t('mail.test_body')]);
  }
}

export interface SendResult {
  ok: boolean;
  /** 未配置密钥时为 'not-configured'，调用方据此决定是否提示用户 */
  reason?: 'not-configured' | 'provider-error';
  /** SMTP 失败阶段与响应码（不含响应体——里面可能带收件人信息），供管理界面诊断 */
  detail?: { phase: string; code: number | null };
}

/** 无 DB 环境（单测、队列消费兜底）下直接取绑定值。键必须与 configuration.ts 的 CONFIGURATION 保持同步。 */
function fallbackConfiguration(env: EmailEnv): Record<string, string> {
  return {
    mail_driver: env.MAIL_DRIVER ?? 'resend',
    resend_api_key: env.RESEND_API_KEY ?? '',
    mail_from: env.MAIL_FROM ?? '',
    smtp_host: env.SMTP_HOST ?? '',
    smtp_port: env.SMTP_PORT ?? '0',
    smtp_encryption: env.SMTP_ENCRYPTION ?? 'starttls',
    smtp_username: env.SMTP_USERNAME ?? '',
    smtp_password: env.SMTP_PASSWORD ?? '',
    site_url: env.APP_URL ?? '',
  };
}

const SMTP_DEFAULT_PORTS: Record<SmtpEncryption, number> = { starttls: 587, ssl: 465, none: 25 };

/**
 * 解析发件人设置。允许三种写法：
 * - `名称 <邮箱>` 完整形式（resend 必须用它，API 按完整地址发送）；
 * - 纯邮箱地址；
 * - 只写显示名 —— smtp 驱动下自动用 SMTP 账号邮箱补全（用户无需关心格式，
 *   也避免账号与发件地址不同域被服务器拒收）；显示名原样保留。
 */
export function resolveMailFrom(mailFrom: string, smtpUsername?: string): { name?: string; address: string } {
  const trimmed = mailFrom.trim();
  if (trimmed.includes('<')) return parseAddress(trimmed);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { address: trimmed };
  const account = (smtpUsername ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) return { address: trimmed };
  return { ...(trimmed ? { name: trimmed } : {}), address: account };
}

/** 解析 SMTP 配置；端口留 0 时按加密方式取惯用默认 */
function smtpOptions(configuration: Record<string, string>): { options: SmtpOptions; missing: boolean } {
  const encryption = (['starttls', 'ssl', 'none'] as const).includes(configuration.smtp_encryption as SmtpEncryption)
    ? configuration.smtp_encryption as SmtpEncryption
    : 'starttls';
  const port = Number(configuration.smtp_port);
  const host = (configuration.smtp_host ?? '').trim();
  return {
    options: {
      host,
      port: Number.isInteger(port) && port > 0 && port <= 65_535 ? port : SMTP_DEFAULT_PORTS[encryption],
      encryption,
      ...(configuration.smtp_username ? { username: configuration.smtp_username } : {}),
      ...(configuration.smtp_password ? { password: configuration.smtp_password } : {}),
    },
    missing: !host,
  };
}

/**
 * 发送邮件。
 *
 * 失败不抛异常：注册或找回密码不该因为邮件服务故障而整体失败。
 * 调用方通过返回值决定是否给用户提示。
 */
export async function sendEmail(env: EmailEnv, template: EmailTemplate, idempotencyKey?: string): Promise<SendResult> {
  const configuration = env.DB
    ? await configurationValues(env as unknown as ConfigurationSourceEnv)
    : fallbackConfiguration(env);
  const driver = configuration.mail_driver === 'smtp' ? 'smtp' : 'resend';
  const smtp = driver === 'smtp' ? smtpOptions(configuration) : undefined;
  if (smtp ? smtp.missing : !configuration.resend_api_key) return { ok: false, reason: 'not-configured' };

  const overrides = env.DB ? await translationOverrides({ DB: env.DB }, normalizeLocale(template.locale || 'en')) : [];
  const appUrl = (configuration.site_url || env.APP_URL || 'http://localhost:8787').replace(/\/$/, '');
  const { subject, html, text } = renderEmail(template, appUrl, overrides);

  if (smtp) {
    // SMTP 协议没有 resend 那样的幂等键；DATA 250 即已投递，广播重试
    // 造成的重复投递由 QUIT 容错（见 smtp.ts）压到最小
    const from = resolveMailFrom(configuration.mail_from ?? '', smtp.options.username);
    try {
      await sendViaSmtp(smtp.options, {
        from: from.name ? `${from.name} <${from.address}>` : from.address,
        to: template.to, subject, text, html,
      });
    } catch (error) {
      // 只记阶段与响应码，不记响应体 —— 里面可能带收件人信息
      if (error instanceof SmtpError) {
        console.error('SMTP 发送失败', error.phase, error.code ?? '');
        return { ok: false, reason: 'provider-error', detail: { phase: error.phase, code: error.code ?? null } };
      }
      console.error('SMTP 发送失败', 'connection');
      return { ok: false, reason: 'provider-error' };
    }
    return { ok: true };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configuration.resend_api_key}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify({
      // resend 没有 SMTP 账号可补全，原样发送；管理员写的非法格式由 API 拒绝并归为 provider-error
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
  else if (typeof message.receiver === 'string' && message.receiver !== 'all') { predicates.push(noCaseEq('email', '?')); values.push(message.receiver); }
  const rows = await env.DB.prepare(`SELECT id,email,locale FROM users WHERE ${predicates.join(' AND ')} ORDER BY id LIMIT 50`).bind(...values).all<{ id: number; email: string; locale: string | null }>();
  for (const recipient of rows.results) {
    const result = await sendEmail(env, { kind: 'admin-broadcast', to: recipient.email, title: message.title, content: message.content, locale: recipient.locale }, `${message.broadcastId}:${recipient.id}`);
    if (!result.ok) throw new Error(result.reason === 'not-configured' ? 'Email is not configured' : 'Email delivery failed');
  }
  if (rows.results.length === 50) {
    if (!await enqueueBroadcastEmail(env, { ...message, afterId: rows.results.at(-1)!.id })) throw new Error('Email queue unavailable');
  }
}

/** 邮件是否已配置。用于在界面与接口层面提前告知用户。env 需先过 resolveConfiguration。 */
export function isEmailConfigured(env: EmailEnv): boolean {
  return env.MAIL_DRIVER === 'smtp' ? Boolean(env.SMTP_HOST) : typeof env.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.length > 0;
}
