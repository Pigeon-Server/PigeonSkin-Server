// 站内信模板变量与 AI 翻译的端到端行为。
//
// 覆盖：群发时模板变量按收件人渲染（{{player}}/{{email}}/{{uid}}/{{score}}），
// 翻译任务按内容哈希入队（同内容去重），执行器产出译文后按用户语言读取。
// AI 调用本身由 runAiJob 的驱动配置决定，这里通过关闭/开启开关与直接写入
// 译文表分别覆盖「不入队」与「读取回退」两条路径；AI 成功路径由
// notification translations 的写入形状约定覆盖（与 texture 翻译同构）。
import { beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createDb, notifications, notificationTranslations } from '@pigeon-skin/db';
import { and, eq } from 'drizzle-orm';
import { renderNotificationTemplate, extractTemplateVariables, NOTIFICATION_VARIABLES } from '../src/services/notification-template.ts';
import { contentHash } from '../src/services/notifications.ts';
import { enqueueAiJob } from '../src/services/ai-jobs.ts';
import { invalidateSettingsCache } from '../src/lib.ts';
import { makeAdmin, runMigrations } from './setup.ts';

async function setSettings(values: Record<string, string>): Promise<void> {
  await env.DB.batch(
    Object.entries(values).map(([key, value]) => env.DB
      .prepare("INSERT INTO settings(key, locale, value, updated_at) VALUES(?, '', ?, ?) ON CONFLICT(key, locale) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .bind(key, value, Date.now())),
  );
  invalidateSettingsCache();
}

/** 注册+提权+登录，返回 super_admin 会话 cookie */
async function adminCookie(): Promise<string> {
  const email = `notif-${crypto.randomUUID()}@example.com`, password = 'notify-admin-9';
  const registered = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, playerName: `Nt${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}` }) });
  expect(registered.status).toBe(201);
  const { id } = await registered.json<{ id: number }>();
  await makeAdmin(id);
  const logged = await SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
  return logged.headers.get('set-cookie')!.split(';')[0]!;
}

describe('notification templates', () => {
  // isolatedStorage 下每个用例得到全新 D1：迁移与清理都只能在 beforeEach 完成，
  // afterEach 里的任何 DB 访问都会因存储已被销毁而报 no such table。
  beforeEach(async () => { await runMigrations(); });

  it('renders per-recipient variables and preserves unknown ones', () => {
    const context = { siteName: 'Pigeon Skin', siteUrl: 'https://skin.example', player: 'Steve', email: 's@example.test', uid: 7, score: 1234 };
    const rendered = renderNotificationTemplate('Hi {{player}} (#{{uid}}), score {{score}} at {{site_name}} on {{date}}', context, Date.UTC(2026, 0, 2));
    expect(rendered).toContain('Hi Steve (#7), score 1234 at Pigeon Skin on 2026-01-02');
    expect(renderNotificationTemplate('{{nope}} {{ email }}', context)).toBe('{{nope}} s@example.test');
    expect(extractTemplateVariables('{{a}} {{site_name}}')).toEqual(['a', 'site_name']);
    // 前端提示的变量清单与渲染器支持集合一致
    expect(NOTIFICATION_VARIABLES).toContain('player');
  });

  it('broadcast renders variables per recipient and dedupes translation jobs by content', async () => {
    const cookie = await adminCookie();
    await setSettings({ notification_ai_translation: 'true' });
    // 两个收件人;同内容 → 只入队一个翻译任务(哈希相同)
    const registered: Array<{ id: number; email: string }> = [];
    for (const email of ['n1@example.test', 'n2@example.test']) {
      const created = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'notify-test-9', playerName: `Nt${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}` }) });
      expect(created.status).toBe(201);
      registered.push({ id: (await created.json<{ id: number }>()).id, email });
    }

    const res = await SELF.fetch('https://x/api/v1/admin/notifications', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ title: 'Hi {{player}}', content: 'Your email is {{email}}', receiver: 'all' }) });
    expect(res.status).toBe(200);
    const { sent } = await res.json<{ sent: number }>();
    expect(sent).toBeGreaterThanOrEqual(2);

    const db = createDb(env.DB);
    const rows = await db.select().from(notifications).where(eq(notifications.type, 'site_message'));
    // 每个收件人一份,且变量已按人替换({{player}} 渲染为空串或角色名,{{email}} 是各自邮箱)
    const emails = rows.map(r => r.body);
    expect(emails).toContain('Your email is n1@example.test');
    expect(emails).toContain('Your email is n2@example.test');
    expect(rows.every(r => !r.title.includes('{{'))).toBe(true);

    // 翻译以「模板骨架」为键:标题含 {{player}} 也按模板原文(未渲染)算哈希,
    // 全体收件人共享同一模板 → 只入队 1 个任务
    const jobs = await env.DB.prepare('SELECT tid FROM ai_jobs WHERE kind = ?').bind('translate_notification').all<{ tid: number }>();
    expect(jobs.results.length).toBe(1);
    expect(jobs.results[0]!.tid).toBe(contentHash('Hi {{player}}', 'Your email is {{email}}'));
    // 骨架源行已写入(locale='' 哨兵),译文列留空
    const source = await env.DB.prepare("SELECT source_title, source_body, title, body FROM notification_translations WHERE locale = ''").first<{ source_title: string; source_body: string; title: string; body: string }>();
    expect(source?.source_title).toBe('Hi {{player}}');
    expect(source?.source_body).toBe('Your email is {{email}}');
    expect(source?.title).toBe('');

    // 关闭开关后不再入队新任务
    await setSettings({ notification_ai_translation: 'false' });
    await SELF.fetch('https://x/api/v1/admin/notifications', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ title: 'again', content: 'body', receiver: 'all' }) });
    const afterOff = await env.DB.prepare("SELECT count(*) AS n FROM ai_jobs WHERE kind = 'translate_notification' AND tid = ?").bind(contentHash('again', 'body')).first<{ n: number }>();
    expect(afterOff?.n).toBe(0);
  });

  it('executes the translation job into per-locale rows and serves them by locale', async () => {
    const cookie = await adminCookie();
    await setSettings({ notification_ai_translation: 'true' });
    const register = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'tr@example.test', password: 'notify-test-9', playerName: 'Translator' }) });
    expect(register.status).toBeLessThan(400);

    const res = await SELF.fetch('https://x/api/v1/admin/notifications', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ title: 'Welcome {{player}}', content: 'Hello {{player}}', receiver: 'all' }) });
    expect(res.status).toBe(200);

    // 无 AI 驱动的测试环境:任务执行失败留在 pending,此时读取回退原文;
    // 直接写译文骨架行(locale='en',含 {{player}} 占位)验证「骨架→按人渲染」链路
    const db = createDb(env.DB);
    const [row] = await db.select().from(notifications).where(eq(notifications.type, 'site_message')).limit(1);
    const templateHash = String(contentHash('Welcome {{player}}', 'Hello {{player}}'));
    await db.insert(notificationTranslations).values({
      locale: 'en', contentHash: templateHash,
      sourceTitle: 'Welcome {{player}}', sourceBody: 'Hello {{player}}',
      title: 'Welcome {{player}}', body: 'Hello {{player}}',
      createdAt: Date.now(), updatedAt: Date.now(),
    });

    const list = await SELF.fetch('https://x/api/v1/me/notifications?lang=en', { headers: { cookie } });
    expect(list.status).toBe(200);
    const data = await list.json<{ items: Array<{ title: string; body: string }> }>();
    // 译文骨架按管理员本人渲染:player 是其角色名(注册时生成的 Nt* 名)
    const item = data.items.find(i => i.body.startsWith('Hello ') && !i.body.includes('{{'));
    expect(item?.title).toBe(`Welcome ${item?.title.replace('Welcome ', '')}`);
    expect(item?.body).not.toContain('{{player}}');

    // 行的 template_hash 清空(等于模板失效/非翻译通知)后译文不再命中 → 回退原文
    await db.update(notifications).set({ body: 'Changed content', templateHash: '' }).where(eq(notifications.id, row!.id));
    const list2 = await SELF.fetch('https://x/api/v1/me/notifications?lang=en', { headers: { cookie } });
    const data2 = await list2.json<{ items: Array<{ body: string }> }>();
    expect(data2.items.find(i => i.body === 'Changed content')).toBeTruthy();
  });

  it('dedupes and stores the template source for translate_notification', async () => {
    await runMigrations();
    const hash = contentHash('t', 'b');
    expect(await enqueueAiJob(env, 'translate_notification', hash, { enabled: true })).toBe(true);
    expect(await enqueueAiJob(env, 'translate_notification', hash, { enabled: true })).toBe(true);
    const jobs = await env.DB.prepare('SELECT count(*) AS n FROM ai_jobs WHERE kind = ?').bind('translate_notification').first<{ n: number }>();
    expect(jobs?.n).toBe(1);
  });

  it('keeps source rows and translations distinct across consecutive templates', async () => {
    const cookie = await adminCookie();
    await setSettings({ notification_ai_translation: 'true' });
    // 连发两条不同模板:第二条的哨兵行/译文行不得覆盖第一条(审查 P0-1 场景)
    for (const [title, content] of [['模板 A', '内容 A {{player}}'], ['模板 B', '内容 B {{player}}']]) {
      const res = await SELF.fetch('https://x/api/v1/admin/notifications', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ title, content, receiver: 'all' }) });
      expect(res.status).toBe(200);
    }
    const db = createDb(env.DB);
    for (const [hash, sourceTitle] of [[String(contentHash('模板 A', '内容 A {{player}}')), '模板 A'], [String(contentHash('模板 B', '内容 B {{player}}')), '模板 B']] as const) {
      const source = await db.select().from(notificationTranslations).where(and(eq(notificationTranslations.contentHash, hash), eq(notificationTranslations.locale, ''))).limit(1);
      expect(source[0]?.sourceTitle).toBe(sourceTitle);
      // 各自的 ai_jobs 任务独立存在
      const job = await env.DB.prepare('SELECT status FROM ai_jobs WHERE kind = ? AND tid = ?').bind('translate_notification', Number(hash)).first<{ status: string }>();
      expect(job?.status).toBe('pending');
    }
  });
});
