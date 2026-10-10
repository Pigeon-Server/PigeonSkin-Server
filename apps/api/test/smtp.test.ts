// SMTP 发信链路测试。
//
// 不连真实网络：连接器整体替换为内存假服务器，按收到的命令逐条回放
// 标准响应，断言完整会话（EHLO/STARTTLS/AUTH/信封/DATA 报文/QUIT）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import {
  buildMime, dotStuff, encodeHeaderText, parseAddress, sendViaSmtp, smtpTransport, SmtpError,
  type SmtpConnection,
} from '../src/services/smtp.ts';
import { isEmailConfigured, processBroadcastEmail, resolveMailFrom, sendEmail, type EmailEnv } from '../src/services/email.ts';
import type { EmailQueueMessage } from '../src/services/email.ts';
import { invalidateSettingsCache } from '../src/lib.ts';
import { makeAdmin, runMigrations } from './setup.ts';

const MAIL_KEYS = ['mail_driver', 'smtp_host', 'smtp_port', 'smtp_encryption', 'smtp_username', 'smtp_password', 'mail_from'] as const;

async function setMailSettings(values: Record<string, string>): Promise<void> {
  await env.DB.batch(
    Object.entries(values).map(([key, value]) => env.DB
      .prepare("INSERT INTO settings(key, locale, value, updated_at) VALUES(?, '', ?, ?) ON CONFLICT(key, locale) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .bind(key, value, Date.now())),
  );
  invalidateSettingsCache();
}

async function clearMailSettings(): Promise<void> {
  await env.DB.prepare(`DELETE FROM settings WHERE key IN (${MAIL_KEYS.map(() => '?').join(',')}) AND locale = ''`).bind(...MAIL_KEYS).run();
  invalidateSettingsCache();
}

/** 内存 SMTP 假服务器：request/response 逐条回放，记录客户端写入的每一行 */
class FakeServer {
  /** 客户端写入的命令与 DATA 报文行（DATA 正文也逐行记录，终止符 '.' 除外） */
  readonly lines: string[] = [];
  upgrades = 0;
  closed = false;
  private inData = false;
  private pending: Uint8Array[] = [];
  private readonly replies: (line: string) => string | string[] | null;

  constructor(
    greeting: string,
    replies: (line: string) => string | string[] | null,
  ) {
    this.replies = replies;
    this.push(greeting);
  }

  private push(replies: string | string[]): void {
    for (const line of Array.isArray(replies) ? replies : [replies]) {
      this.pending.push(new TextEncoder().encode(`${line}\r\n`));
    }
  }

  private receive(line: string): void {
    if (this.inData) {
      if (line !== '.') { this.lines.push(line); return; }
      this.inData = false;
    }
    this.lines.push(line);
    // DATA 命令本身要有 354 应答，其后的正文才进入逐行记录
    if (line === 'DATA') this.inData = true;
    const reply = this.replies(line);
    if (reply !== null) this.push(reply);
  }

  connection(): SmtpConnection {
    const makeConnection = (server: FakeServer): SmtpConnection => ({
      async read() { return server.pending.shift() ?? null; },
      async write(chunk) {
        // 假设每次 write 都是完整行块（客户端确实整块写）；末尾 CRLF 切出的空串丢弃
        for (const line of new TextDecoder().decode(chunk).split('\r\n')) {
          if (line !== '') server.receive(line);
        }
      },
      startTls() {
        server.upgrades++;
        return makeConnection(server);
      },
      async close() { server.closed = true; },
    });
    return makeConnection(this);
  }
}

/** 取 multipart 报文里某个 part 的 base64 正文并解码成 UTF-8 文本 */
function decodePart(message: string, type: string): string {
  const marker = `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n`;
  const start = message.indexOf(marker);
  if (start === -1) throw new Error(`part not found: ${type}`);
  const blockStart = start + marker.length;
  const blockEnd = message.indexOf('\r\n--', blockStart);
  const binary = atob(message.slice(blockStart, blockEnd));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

const SAMPLE_CONTENT = {
  from: 'Pigeon Skin <noreply@skin.example.test>',
  to: 'reader@example.test',
  subject: '连接确认',
  text: '第一行文本\n最后一行',
  html: '<p>你好</p>',
};

describe('SMTP protocol', () => {
  it('negotiates STARTTLS, authenticates and delivers the message', async () => {
    const server = new FakeServer('220 mail.example.test ESMTP ready', (line) => {
      if (line.startsWith('EHLO')) return ['250-mail.example.test', '250-STARTTLS', '250-AUTH LOGIN PLAIN', '250 SIZE 10485760'];
      if (line === 'STARTTLS') return '220 Ready to start TLS';
      if (line === 'AUTH LOGIN') return '334 VXNlcm5hbWU6';
      if (line === btoa('user@example.test')) return '334 UGFzc3dvcmQ6';
      if (line === btoa('p4ssw0rd')) return '235 2.7.0 accepted';
      if (line.startsWith('MAIL FROM')) return '250 2.1.0 OK';
      if (line.startsWith('RCPT TO')) return '250 2.1.5 OK';
      if (line === 'DATA') return '354 End data with <CR><LF>.<CR><LF>';
      if (line === 'QUIT') return '221 2.0.0 closing';
      return '250 2.0.0 OK: queued as 123';
    });
    await sendViaSmtp(
      { host: 'mail.example.test', port: 587, encryption: 'starttls', username: 'user@example.test', password: 'p4ssw0rd', heloName: 'skin.example.test' },
      SAMPLE_CONTENT,
      async () => server.connection(),
    );
    expect(server.upgrades).toBe(1);
    expect(server.closed).toBe(true);
    expect(server.lines[0]).toBe('EHLO skin.example.test');
    // STARTTLS 之后必须重新 EHLO
    expect(server.lines.filter((line) => line.startsWith('EHLO'))).toHaveLength(2);
    expect(server.lines).toContain('AUTH LOGIN');
    expect(server.lines).toContain('MAIL FROM:<noreply@skin.example.test>');
    expect(server.lines).toContain('RCPT TO:<reader@example.test>');
    expect(server.lines.at(-1)).toBe('QUIT');

    const dataStart = server.lines.indexOf('DATA');
    const message = server.lines.slice(dataStart + 1, server.lines.indexOf('.')).join('\r\n');
    expect(message).toContain('Auto-Submitted: auto-generated');
    expect(message).toMatch(/^Subject: =\?UTF-8\?B\?[^?]+\?=$/m);
    expect(message).toContain('Content-Type: multipart/alternative; boundary="');
    expect(decodePart(message, 'text/html')).toBe('<p>你好</p>');
    expect(decodePart(message, 'text/plain')).toContain('最后一行');
  });

  it('sends plaintext without AUTH when no credentials are configured', async () => {
    const server = new FakeServer('220 relay.local ESMTP', (line) => {
      if (line.startsWith('EHLO')) return '250 relay.local';
      if (line.startsWith('MAIL FROM')) return '250 OK';
      if (line.startsWith('RCPT TO')) return '251 User not local; will forward';
      if (line === 'DATA') return '354 Go ahead';
      if (line === 'QUIT') return '221 Bye';
      return '250 OK';
    });
    await sendViaSmtp(
      { host: 'relay.local', port: 25, encryption: 'none' },
      { ...SAMPLE_CONTENT, from: 'noreply@skin.example.test' },
      async () => server.connection(),
    );
    expect(server.upgrades).toBe(0);
    expect(server.lines).not.toContain('STARTTLS');
    expect(server.lines.filter((line) => line.startsWith('AUTH'))).toHaveLength(0);
    expect(server.lines).toContain('RCPT TO:<reader@example.test>');
  });

  it('falls back to HELO when the server rejects EHLO', async () => {
    const server = new FakeServer('220 old.relay ESMTP', (line) => {
      if (line === 'EHLO skin.example.test') return '500 Command unrecognized';
      if (line === 'HELO skin.example.test') return '250 old.relay';
      if (line === 'DATA') return '354 Go ahead';
      if (line === 'QUIT') return '221 Bye';
      return '250 OK';
    });
    await sendViaSmtp(
      { host: 'old.relay', port: 25, encryption: 'none' },
      { ...SAMPLE_CONTENT, from: 'noreply@skin.example.test' },
      async () => server.connection(),
    );
    expect(server.lines).toContain('HELO skin.example.test');
  });

  it('treats the message as delivered even when QUIT fails after DATA 250', async () => {
    // 部分中继收到 QUIT 就直接断开；RFC 5321 §4.1.1.10 下 DATA 250 即投递成功
    const server = new FakeServer('220 relay.local ESMTP', (line) => {
      if (line.startsWith('EHLO')) return '250 relay.local';
      if (line === 'DATA') return '354 Go ahead';
      if (line === 'QUIT') return null;
      return '250 OK';
    });
    await expect(sendViaSmtp(
      { host: 'relay.local', port: 25, encryption: 'none' },
      { ...SAMPLE_CONTENT, from: 'noreply@skin.example.test' },
      async () => server.connection(),
    )).resolves.toBeUndefined();
    expect(server.lines).toContain('QUIT');
  });

  it('reports failures with the failing phase and response code', async () => {
    const server = new FakeServer('220 mail.example.test ESMTP', (line) => {
      if (line.startsWith('EHLO')) return '250 mail.example.test';
      if (line.startsWith('MAIL FROM')) return '250 OK';
      if (line.startsWith('RCPT TO')) return '550 5.1.1 <reader@example.test>: recipient unknown';
      return '250 OK';
    });
    await expect(sendViaSmtp(
      { host: 'mail.example.test', port: 587, encryption: 'none' },
      SAMPLE_CONTENT,
      async () => server.connection(),
    )).rejects.toMatchObject({ name: 'SmtpError', phase: 'rcpt-to', code: 550 });

    const auth = new FakeServer('220 auth.example.test ESMTP', (line) => {
      if (line.startsWith('EHLO')) return '250 auth.example.test';
      if (line === 'AUTH LOGIN') return '334 VXNlcm5hbWU6';
      if (line === btoa('user@example.test')) return '334 UGFzc3dvcmQ6';
      if (line === btoa('wrong')) return '535 5.7.8 authentication failed';
      return '250 OK';
    });
    await expect(sendViaSmtp(
      { host: 'auth.example.test', port: 587, encryption: 'none', username: 'user@example.test', password: 'wrong' },
      SAMPLE_CONTENT,
      async () => auth.connection(),
    )).rejects.toMatchObject({ name: 'SmtpError', phase: 'auth', code: 535 });
  });
});

describe('MIME building', () => {
  it('encodes headers and bodies, keeps CRLF line endings', () => {
    const message = buildMime(SAMPLE_CONTENT);
    // 允许 CRLF，禁止裸 LF（每个换行必须是 \r\n）
    expect(message).not.toMatch(/(?<!\r)\n/);
    expect(message).toMatch(/^Date: .+ GMT\r\n/m);
    expect(message).toContain('From: Pigeon Skin <noreply@skin.example.test>');
    expect(message).toContain('To: reader@example.test');
    expect(message).toMatch(/^Message-ID: <[\w-]+@skin\.example\.test>\r\n/m);
    expect(decodePart(message, 'text/plain')).toContain('第一行文本');
    expect(decodePart(message, 'text/html')).toContain('<p>你好</p>');
  });

  it('encodes non-ASCII display names as encoded-words', () => {
    const message = buildMime({ ...SAMPLE_CONTENT, from: '鸽子信箱 <noreply@skin.example.test>' });
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode('鸽子信箱')));
    const from = message.split('\r\n').find((line) => line.startsWith('From: '))!;
    expect(from).toBe(`From: =?UTF-8?B?${encoded}?= <noreply@skin.example.test>`);
  });

  it('rejects header-injecting recipients and invalid addresses', () => {
    for (const content of [
      { ...SAMPLE_CONTENT, to: 'a@b.test\r\nBcc: victim@x.test' },
      { ...SAMPLE_CONTENT, to: 'not-an-address' },
      { ...SAMPLE_CONTENT, from: 'noreply@skin.example.test\r\nBcc: victim@x.test' },
      { ...SAMPLE_CONTENT, subject: 'hi\r\nBcc: victim@x.test' },
    ]) {
      expect(() => buildMime(content)).toThrow(SmtpError);
    }
  });

  it('doubles leading dots of DATA lines', () => {
    expect(dotStuff('\r\n.line one\r\n..already dotted\r\nplain')).toBe('\r\n..line one\r\n...already dotted\r\nplain');
  });

  it('parses display-name address forms', () => {
    expect(parseAddress('Skin Server <noreply@x.test>')).toEqual({ name: 'Skin Server', address: 'noreply@x.test' });
    expect(parseAddress('"Q. User" <user@x.test>')).toEqual({ name: 'Q. User', address: 'user@x.test' });
    expect(parseAddress('noreply@x.test')).toEqual({ address: 'noreply@x.test' });
  });

  it('encodes header text without splitting multibyte characters', () => {
    // 纯 ASCII 原样输出
    expect(encodeHeaderText('Plain Subject')).toBe('Plain Subject');
    // 非 ASCII 走 RFC 2047 B 编码；解码回来必须逐字相等（30 字节切块不撕裂多字节）
    const value = ' pigeon 鸽子 skin 皮肤 '.repeat(6);
    const encoded = encodeHeaderText(value);
    for (const word of encoded.split('\r\n ')) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+={0,2}\?=$/);
      expect(word.length).toBeLessThanOrEqual(76);
    }
    const decoded = encoded.split('\r\n ')
      .map((word) => new TextDecoder().decode(Uint8Array.from(atob(word.slice(10, -2)), (char) => char.charCodeAt(0))))
      .join('');
    expect(decoded).toBe(value);
  });
});

describe('mail driver dispatch', () => {
  const originalConnector = smtpTransport.connect;
  let server: FakeServer;
  // isolatedStorage 下每个用例得到全新 D1：迁移与清理都只能在 beforeEach（隔离边界内）
  // 完成，afterEach 里的任何 DB 访问都会因存储已被销毁而报 no such table。
  beforeEach(async () => { await runMigrations(); await clearMailSettings(); });
  afterEach(() => { smtpTransport.connect = originalConnector; });

  it('resolves mail_from display names against the SMTP account', () => {
    // 纯名称 → 地址取 SMTP 账号,名称保留
    expect(resolveMailFrom('Pigeon Skin', 'message@fsj-mc.club')).toEqual({ name: 'Pigeon Skin', address: 'message@fsj-mc.club' });
    // 完整形式与纯邮箱原样透传,账号不参与
    expect(resolveMailFrom('Site <noreply@skin.test>', 'message@fsj-mc.club')).toEqual({ name: 'Site', address: 'noreply@skin.test' });
    expect(resolveMailFrom('noreply@skin.test', '')).toEqual({ address: 'noreply@skin.test' });
    // 账号缺失/非邮箱时纯名称只能原样回落(后续信封校验会拒绝)
    expect(resolveMailFrom('Pigeon Skin', '')).toEqual({ address: 'Pigeon Skin' });
    expect(resolveMailFrom('Pigeon Skin', 'not-an-email')).toEqual({ address: 'Pigeon Skin' });
    // 空值边界
    expect(resolveMailFrom('', 'message@fsj-mc.club')).toEqual({ address: 'message@fsj-mc.club' });
  });

  it('routes through SMTP with the configured transport', async () => {
    await setMailSettings({ mail_driver: 'smtp', smtp_host: 'mail.example.test', smtp_port: '2525', smtp_encryption: 'none', smtp_username: '', smtp_password: '', mail_from: 'Site <noreply@skin.test>' });
    server = new FakeServer('220 relay ESMTP', (line) => {
      if (line.startsWith('EHLO')) return '250 relay';
      if (line === 'DATA') return '354 Go';
      if (line === 'QUIT') return '221 Bye';
      return '250 OK';
    });
    let seenHost = '', seenPort = 0, seenEncryption = '';
    smtpTransport.connect = async (host, port, encryption) => {
      seenHost = host; seenPort = port; seenEncryption = encryption;
      return server.connection();
    };
    const result = await sendEmail({ DB: env.DB, APP_URL: 'https://skin.example' } as EmailEnv, { kind: 'security-code', to: 'user@example.test', code: '123456', locale: 'en' });
    expect(result).toEqual({ ok: true });
    expect(seenHost).toBe('mail.example.test');
    expect(seenPort).toBe(2525);
    expect(seenEncryption).toBe('none');
    expect(server.lines).toContain('MAIL FROM:<noreply@skin.test>');
    expect(server.lines).toContain('RCPT TO:<user@example.test>');
  });

  it('expands a display-name mail_from to the SMTP account address', async () => {
    await setMailSettings({ mail_driver: 'smtp', smtp_host: 'mail.example.test', smtp_encryption: 'none', smtp_username: 'message@fsj-mc.club', smtp_password: 'secret', mail_from: 'Pigeon Skin' });
    server = new FakeServer('220 relay ESMTP', (line) => {
      if (line.startsWith('EHLO')) return '250 relay';
      if (line === 'AUTH LOGIN') return '334 VXNlcm5hbWU6';
      if (line === btoa('message@fsj-mc.club')) return '334 UGFzc3dvcmQ6';
      if (line === btoa('secret')) return '235 Auth ok';
      if (line === 'DATA') return '354 Go';
      if (line === 'QUIT') return '221 Bye';
      return '250 OK';
    });
    smtpTransport.connect = async () => server.connection();
    const result = await sendEmail({ DB: env.DB, APP_URL: 'https://skin.example' } as EmailEnv, { kind: 'security-code', to: 'user@example.test', code: '123456', locale: 'en' });
    expect(result).toEqual({ ok: true });
    // 信封用补全后的账号地址;DATA 头部保留显示名
    expect(server.lines).toContain('MAIL FROM:<message@fsj-mc.club>');
    expect(server.lines).toContain('AUTH LOGIN');
    const dataBody = server.lines.join('\n');
    expect(dataBody).toContain('From: Pigeon Skin <message@fsj-mc.club>');
  });

  it('picks the conventional port when the port is left automatic', async () => {
    await setMailSettings({ mail_driver: 'smtp', smtp_host: 'mail.example.test', smtp_port: '0', smtp_encryption: 'ssl' });
    let port = 0;
    smtpTransport.connect = async (_host, selected, _encryption) => {
      port = selected;
      return new FakeServer('220 tls relay', (line) => {
        if (line.startsWith('EHLO')) return '250 tls relay';
        if (line === 'DATA') return '354 Go';
        if (line === 'QUIT') return '221 Bye';
        return '250 OK';
      }).connection();
    };
    // ssl 驱动下默认 465；假服务器不做真实 TLS，仅验证端口推断与会话流程
    const result = await sendEmail({ DB: env.DB, APP_URL: 'https://skin.example' } as EmailEnv, { kind: 'test-mail', to: 'user@example.test', locale: 'en' });
    expect(port).toBe(465);
    expect(result).toEqual({ ok: true });
  });

  it('rejects unconfigured drivers before opening a connection', async () => {
    await setMailSettings({ mail_driver: 'smtp', smtp_host: '' });
    const result = await sendEmail({ DB: env.DB, APP_URL: 'https://skin.example' } as EmailEnv, { kind: 'security-code', to: 'user@example.test', code: '123456', locale: 'en' });
    expect(result).toEqual({ ok: false, reason: 'not-configured' });

    await clearMailSettings();
    const unset = await sendEmail({ DB: env.DB, APP_URL: 'https://skin.example' } as EmailEnv, { kind: 'security-code', to: 'user@example.test', code: '123456', locale: 'en' });
    expect(unset).toEqual({ ok: false, reason: 'not-configured' });
  });

  it('maps SMTP failures to provider-error without throwing', async () => {
    await setMailSettings({ mail_driver: 'smtp', smtp_host: 'mail.example.test', smtp_encryption: 'none', mail_from: 'noreply@skin.test' });
    // 收件人被拒 → provider-error,不抛异常
    const rejecting = new FakeServer('220 relay ESMTP', (line) => {
      if (line.startsWith('EHLO')) return '250 relay';
      if (line.startsWith('RCPT TO')) return '550 5.1.1 unknown recipient';
      if (line === 'QUIT') return '221 Bye';
      return '250 OK';
    });
    smtpTransport.connect = async () => rejecting.connection();
    const denied = await sendEmail({ DB: env.DB, APP_URL: 'https://skin.example' } as EmailEnv, { kind: 'security-code', to: 'ghost@example.test', code: '123456', locale: 'en' });
    expect(denied).toEqual({ ok: false, reason: 'provider-error', detail: { phase: 'rcpt-to', code: 550 } });

    // 连接直接被断开 → provider-error,无结构化详情
    smtpTransport.connect = async () => {
      const dead = new FakeServer('', () => null);
      return dead.connection();
    };
    const dead = await sendEmail({ DB: env.DB, APP_URL: 'https://skin.example' } as EmailEnv, { kind: 'security-code', to: 'user@example.test', code: '123456', locale: 'en' });
    expect(dead).toEqual({ ok: false, reason: 'provider-error', detail: { phase: 'reply', code: null } });
  });

  it('delivers queued broadcasts through SMTP and advances the cursor', async () => {
    await setMailSettings({ mail_driver: 'smtp', smtp_host: 'mail.example.test', smtp_encryption: 'none', mail_from: 'Site <noreply@skin.test>' });
    const batches: FakeServer[] = [];
    smtpTransport.connect = async () => {
      const server = new FakeServer('220 relay ESMTP', (line) => {
        if (line.startsWith('EHLO')) return '250 relay';
        if (line === 'DATA') return '354 Go';
        if (line === 'QUIT') return '221 Bye';
        return '250 OK';
      });
      batches.push(server);
      return server.connection();
    };
    const sent: EmailQueueMessage[] = [];
    const users = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, email: `u${index}@example.test`, locale: 'en' }));
    const envStub = {
      APP_URL: 'https://skin.example',
      // settings 查询返回空时配置从绑定回退:走 SMTP 驱动
      MAIL_DRIVER: 'smtp', SMTP_HOST: 'mail.example.test', SMTP_ENCRYPTION: 'none',
      MAIL_FROM: 'Site <noreply@skin.test>',
      DB: {
        // settings 查询(带 IN 列表)回存档配置;用户游标查询回第一批 50 人,再往后为空
        prepare: (sql: string) => ({
          bind: (..._values: unknown[]) => ({
            all: async () => ({ results: sql.includes('FROM settings') ? [] : (users.length ? users.splice(0, 50) : []) }),
          }),
        }),
      },
      EMAIL_NOTIFICATIONS: { send: async (body: EmailQueueMessage) => { sent.push(body); } },
    } as unknown as Parameters<typeof processBroadcastEmail>[0];
    await processBroadcastEmail(envStub, { broadcastId: 'bc-1', receiver: 'all', title: 'News', content: 'Hello', afterId: 0 });
    expect(batches).toHaveLength(50);
    expect(sent).toEqual([{ broadcastId: 'bc-1', receiver: 'all', title: 'News', content: 'Hello', afterId: 50 }]);
    // 每个收件人一条独立 SMTP 连接
    const allLines = batches.flatMap((server) => server.lines);
    expect(allLines).toContain('MAIL FROM:<noreply@skin.test>');
    expect(allLines).toContain('RCPT TO:<u0@example.test>');
    expect(allLines).toContain('RCPT TO:<u49@example.test>');
  });

  it('decides availability from the active driver', () => {
    expect(isEmailConfigured({ MAIL_DRIVER: 'smtp', SMTP_HOST: 'mail.example.test' } as EmailEnv)).toBe(true);
    expect(isEmailConfigured({ MAIL_DRIVER: 'smtp' } as EmailEnv)).toBe(false);
    expect(isEmailConfigured({ RESEND_API_KEY: 'key' } as EmailEnv)).toBe(true);
    expect(isEmailConfigured({} as EmailEnv)).toBe(false);
  });

  it('sends the admin test email only to super admins', async () => {
    await setMailSettings({ mail_driver: 'smtp', smtp_host: 'mail.example.test', smtp_encryption: 'none', mail_from: 'Site <noreply@skin.test>' });
    const superEmail = `smtp-admin-${crypto.randomUUID()}@example.test`, adminEmail = `smtp-staff-${crypto.randomUUID()}@example.test`;
    const register = async (email: string) => {
      const created = await SELF.fetch('https://x/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'smtp-test-9-pass', playerName: `St${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}` }) });
      expect(created.status).toBe(201);
      const { id } = await created.json<{ id: number }>();
      await makeAdmin(id);
      const logged = await SELF.fetch('https://x/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password: 'smtp-test-9-pass' }) });
      return { id, cookie: logged.headers.get('set-cookie')!.split(';')[0]! };
    };
    const superUser = await register(superEmail);
    const staffUser = await register(adminEmail);
    // register 辅助把两人都提为超管，再把其中一人降为普通管理员
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(staffUser.id).run();

    server = new FakeServer('220 relay ESMTP', (line) => {
      if (line.startsWith('EHLO')) return '250 relay';
      if (line === 'DATA') return '354 Go';
      if (line === 'QUIT') return '221 Bye';
      return '250 OK';
    });
    smtpTransport.connect = async () => server.connection();

    const denied = await SELF.fetch('https://x/api/v1/admin/settings/email-test', { method: 'POST', headers: { cookie: staffUser.cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({}) });
    expect(denied.status).toBe(403);

    const allowed = await SELF.fetch('https://x/api/v1/admin/settings/email-test', { method: 'POST', headers: { cookie: superUser.cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ to: 'operator@example.test' }) });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, reason: null, detail: null });
    expect(server.lines).toContain('RCPT TO:<operator@example.test>');
  });
});
