// SMTP 直发客户端，基于 cloudflare:sockets。
//
// Workers 没有 Node 的 net/tls，出站 TCP 只能走官方 sockets API：
// - encryption = 'ssl'      连接时即 TLS（465 端口）
// - encryption = 'starttls' 明文连接，握手后 STARTTLS 升级（587 端口）
// - encryption = 'none'     全程明文，仅限内网中继或本地调试
//
// 连接器可注入：sendViaSmtp 默认走真实 sockets，单测里替换成内存假服务器
// 即可覆盖协议全程，不需要真实网络。

export type SmtpEncryption = 'starttls' | 'ssl' | 'none';

export interface SmtpOptions {
  host: string;
  port: number;
  encryption: SmtpEncryption;
  username?: string;
  password?: string;
  /** EHLO 自报的域名；缺省取发件人地址的域 */
  heloName?: string;
  /** 单次连接/读写超时（毫秒） */
  timeoutMs?: number;
}

export interface SmtpContent {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export class SmtpError extends Error {
  /** 失败阶段：connect/greeting/ehlo/starttls/auth/mail-from/rcpt-to/data/close */
  readonly phase: string;
  /** SMTP 响应码；网络层失败时为 undefined */
  readonly code: number | undefined;
  readonly response?: string | undefined;

  constructor(phase: string, code: number | undefined, response?: string) {
    super(`SMTP ${phase} failed${code ? ` (${code})` : ''}`);
    this.name = 'SmtpError';
    this.phase = phase;
    this.code = code;
    this.response = response;
  }
}

/** 连接抽象：字节级读写 + 可选的 STARTTLS 升级。 */
export interface SmtpConnection {
  read(): Promise<Uint8Array | null>;
  write(chunk: Uint8Array): Promise<void>;
  startTls(): SmtpConnection;
  close(): Promise<void>;
}

export type SmtpConnector = (
  host: string,
  port: number,
  encryption: SmtpOptions['encryption'],
) => Promise<SmtpConnection>;

/** 可注入的连接器，测试里整体替换 */
export const smtpTransport: { connect: SmtpConnector } = {
  connect: async (host, port, encryption) => {
    const { connect } = await import('cloudflare:sockets');
    // IPv6 字面量在设置里要求 [::1] 形式（避免与端口拼接歧义），
    // 连接层剥掉方括号，两种写法都能连
    return wrapSocket(connect({ hostname: host.replace(/^\[(.+)\]$/, '$1'), port }, {
      secureTransport: encryption === 'ssl' ? 'on' : encryption === 'starttls' ? 'starttls' : 'off',
      allowHalfOpen: false,
    }));
  },
};

function wrapSocket(socket: Socket): SmtpConnection {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return {
    async read() {
      const active = reader ?? (reader = socket.readable.getReader());
      const result = await active.read();
      return result.done ? null : result.value;
    },
    async write(chunk) {
      const writer = socket.writable.getWriter();
      try { await writer.write(chunk); } finally { writer.releaseLock(); }
    },
    startTls() {
      // 旧流上的锁必须在升级前释放：workerd 对挂着 reader 的 socket 升级
      // STARTTLS 可能失败，官方也明确要求升级后重建 reader/writer
      try { reader?.releaseLock(); } catch { /* 已释放或无锁 */ }
      return wrapSocket(socket.startTls());
    },
    async close() {
      try { await socket.close(); } catch { /* 对端已断开时忽略 */ }
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, phase: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmtpError(phase, undefined, `超时（${ms}ms）`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const encoder = new TextEncoder();

/** 面向行的 SMTP 客户端，处理多行响应与跨读块断行的重组 */
class SmtpClient {
  private buffer = new Uint8Array(0);
  private connection: SmtpConnection;
  private timeoutMs: number;

  constructor(connection: SmtpConnection, timeoutMs: number) {
    this.connection = connection;
    this.timeoutMs = timeoutMs;
  }

  /** STARTTLS 之后底层流被替换，缓冲区作废重来 */
  upgrade(connection: SmtpConnection): void {
    this.connection = connection;
    this.buffer = new Uint8Array(0);
  }

  private async fill(): Promise<void> {
    const chunk = await withTimeout(this.connection.read(), this.timeoutMs, 'read');
    if (!chunk || chunk.length === 0) throw new SmtpError('connection', undefined, '连接被对端关闭');
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  private takeLine(): string | null {
    for (let i = 0; i + 1 < this.buffer.length; i++) {
      if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
        const line = new TextDecoder().decode(this.buffer.slice(0, i));
        this.buffer = this.buffer.slice(i + 2);
        return line;
      }
    }
    return null;
  }

  /** 读一条完整响应：`250-text` 为中间行，`250 text` 为末行 */
  async readReply(): Promise<{ code: number; text: string }> {
    for (;;) {
      const line = this.takeLine();
      if (line === null) { await this.fill(); continue; }
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) throw new SmtpError('reply', undefined, line.slice(0, 120));
      if (match[2] === ' ') return { code: Number(match[1]), text: match[3]! };
    }
  }

  async write(data: string): Promise<void> {
    await withTimeout(this.connection.write(encoder.encode(data)), this.timeoutMs, 'write');
  }

  async command(line: string): Promise<{ code: number; text: string }> {
    await this.write(`${line}\r\n`);
    return this.readReply();
  }
}

function assertReply(reply: { code: number; text: string }, phase: string, expected: number[]): void {
  if (!expected.includes(reply.code)) throw new SmtpError(phase, reply.code, reply.text.slice(0, 120));
}

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...encoder.encode(text)));
}

/** 拆开 `Name <addr>` / `<addr>` / `addr` 三种形式 */
export function parseAddress(value: string): { name?: string; address: string } {
  const trimmed = value.trim();
  const match = /^(.*?)\s*<([^<>]+)>\s*$/.exec(trimmed);
  if (match) {
    const name = match[1]!.trim().replace(/^"(.*)"$/, '$1');
    return { ...(name ? { name } : {}), address: match[2]!.trim() };
  }
  return { address: trimmed };
}

function containsUnsafeHeader(value: string): boolean {
  return /[\r\n<>\\"{}|^`]/.test(value);
}

/**
 * 非 ASCII 头部按 RFC 2047 做 B 编码。按 ≤30 字节切块，保证不切开
 * 多字节字符，且单行 encoded-word 不超过 76 字符的行宽上限。
 */
export function encodeHeaderText(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value.replace(/[\r\n]+/g, ' ');
  const chunks: Uint8Array[] = [];
  let current: number[] = [];
  let size = 0;
  for (const char of value) {
    const bytes = encoder.encode(char);
    if (size + bytes.length > 30) { chunks.push(new Uint8Array(current)); current = []; size = 0; }
    current.push(...bytes);
    size += bytes.length;
  }
  if (current.length) chunks.push(new Uint8Array(current));
  return chunks.map((chunk) => `=?UTF-8?B?${btoa(String.fromCharCode(...chunk))}?=`).join('\r\n ');
}

function base64Wrap(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return (btoa(binary).match(/.{1,76}/g) ?? []).join('\r\n');
}

function formatAddress(address: { name?: string; address: string }): string {
  return address.name ? `${encodeHeaderText(address.name)} <${address.address}>` : address.address;
}

/**
 * 构建完整 MIME 消息（CRLF 行尾）。正文走 base64，避免 8bit 传输在
 * 老中继上的兼容问题；头里的中文走 RFC 2047。
 */
export function buildMime(content: SmtpContent): string {
  const from = parseAddress(content.from);
  const to = parseAddress(content.to);
  if (!from.address || containsUnsafeHeader(from.address) || !/^[^\s@]+@[^\s@]+$/.test(from.address)) {
    throw new SmtpError('config', undefined, '发件人地址无效');
  }
  if (!to.address || containsUnsafeHeader(to.address) || !/^[^\s@]+@[^\s@]+$/.test(to.address)) {
    throw new SmtpError('config', undefined, '收件人地址无效');
  }
  if (containsUnsafeHeader(content.subject)) throw new SmtpError('config', undefined, '主题包含非法字符');

  const domain = from.address.split('@')[1] ?? 'localhost';
  const boundary = `=_pigeon_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${formatAddress(from)}`,
    `To: ${formatAddress(to)}`,
    `Subject: ${encodeHeaderText(content.subject)}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    // 全部是系统自动生成的通知邮件，告知客户端不要自动回复/转发
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string): string =>
    `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Wrap(body)}\r\n`;
  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', content.text)}${part('text/html', content.html)}--${boundary}--\r\n`;
}

/** DATA 阶段的点填充：行首的 `.` 双写，防止提前终止报文 */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r\n)\./g, '$1..');
}

/** 完成一次 SMTP 会话：握手 → （可选 STARTTLS）→ （可选 AUTH）→ 信封 → DATA → QUIT */
export async function sendViaSmtp(
  options: SmtpOptions,
  content: SmtpContent,
  connector: SmtpConnector = smtpTransport.connect,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (options.username && /[\r\n]/.test(options.username)) throw new SmtpError('config', undefined, '用户名包含非法字符');
  if (options.password && /[\r\n]/.test(options.password)) throw new SmtpError('config', undefined, '密码包含非法字符');

  let connection = await withTimeout(connector(options.host, options.port, options.encryption), timeoutMs, 'connect');
  const client = new SmtpClient(connection, timeoutMs);
  try {
    assertReply(await client.readReply(), 'greeting', [220]);

    const heloName = options.heloName ?? parseAddress(content.from).address.split('@')[1] ?? 'localhost';
    const ehlo = async (): Promise<void> => {
      let reply = await client.command(`EHLO ${heloName}`);
      // 老服务器不认识 EHLO 时退回 HELO（失去扩展能力，只剩基本投递）
      if (reply.code >= 500) reply = await client.command(`HELO ${heloName}`);
      assertReply(reply, 'ehlo', [250]);
    };
    await ehlo();

    if (options.encryption === 'starttls') {
      assertReply(await client.command('STARTTLS'), 'starttls', [220]);
      connection = connection.startTls();
      client.upgrade(connection);
      await ehlo();
    }

    if (options.username) {
      if (!options.password) throw new SmtpError('auth', undefined, '已配置用户名但缺少密码');
      assertReply(await client.command('AUTH LOGIN'), 'auth', [334]);
      assertReply(await client.command(toBase64(options.username)), 'auth', [334]);
      assertReply(await client.command(toBase64(options.password)), 'auth', [235]);
    }

    const from = parseAddress(content.from);
    const to = parseAddress(content.to);
    assertReply(await client.command(`MAIL FROM:<${from.address}>`), 'mail-from', [250]);
    assertReply(await client.command(`RCPT TO:<${to.address}>`), 'rcpt-to', [250, 251]);
    assertReply(await client.command('DATA'), 'data', [354]);

    await client.write(dotStuff(buildMime(content)) + '\r\n.\r\n');
    assertReply(await client.readReply(), 'data', [250]);

    // DATA 250 即代表投递成功；部分中继收到 QUIT 就直接关连接，
    // QUIT 的任何失败都不能把已投递的邮件报成失败
    try { await client.command('QUIT'); } catch { /* 已投递，忽略 */ }
  } finally {
    await connection.close();
  }
}
