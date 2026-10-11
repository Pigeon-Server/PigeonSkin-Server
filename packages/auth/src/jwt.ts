// Web access token（JWT / HS256）。
//
// 前端认证是双令牌：短时效 access JWT（本文件）+ 不透明 refresh 令牌
// （sessions 表的 mintTokenWithHash）。JWT 只承载 sub/sid 两个标识，
// 鉴权判断始终以服务端会话行为准。签名用 WebCrypto HMAC 手工实现而
// 不是引入 jose —— 本包同时被 Node 侧迁移工具引用，保持零新增依赖，
// globalThis.crypto（subtle）在 Workers 与 Node 18+ 都可用。

const WEB_ISSUER = 'pigeon-skin:web';
const encoder = new TextEncoder();

export interface WebTokenClaims {
  /** 用户 id（十进制字符串 —— JWT sub 规范要求 string） */
  readonly sub: string;
  /** 会话 id = refresh 令牌的 SHA-256（sessions.id），服务端撤销检查的键 */
  readonly sid: string;
  readonly iss: string;
  readonly iat: number;
  readonly exp: number;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** 返回独立 ArrayBuffer（而非视图），便于直接作为 BufferSource 传给 WebCrypto */
function base64UrlDecode(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** 签发 web access token；过期由调用方用 ttlSeconds 控制 */
export async function mintWebAccessToken(
  secret: string,
  userId: number,
  sessionId: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64urlEncode(encoder.encode(JSON.stringify({
    sub: String(userId), sid: sessionId, iss: WEB_ISSUER, iat: now, exp: now + ttlSeconds,
  })));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64urlEncode(new Uint8Array(signature))}`;
}

/**
 * 校验 web access token。签名验失、算法不是 HS256、claims 缺失或已过期
 * （含 leeway 容忍时钟偏差）都返回 null，由调用方统一按 401 处理。
 * subtle.verify 内部是常数时间比较。
 */
export async function verifyWebAccessToken(
  secret: string,
  token: string,
  leewaySeconds = 30,
): Promise<WebTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = parts[0]!, payload = parts[1]!, signature = parts[2]!;

  let headerJson: { alg?: string };
  try {
    headerJson = JSON.parse(new TextDecoder().decode(base64UrlDecode(header)));
  } catch {
    return null;
  }
  // 算法钉死 HS256：任何其它 alg（含 none）直接拒绝，防算法混淆攻击
  if (headerJson.alg !== 'HS256') return null;

  const key = await hmacKey(secret);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(signature), encoder.encode(`${header}.${payload}`));
  } catch {
    return null;
  }
  if (!valid) return null;

  let claims: WebTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }
  if (claims.iss !== WEB_ISSUER) return null;
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.sid !== 'string' || !claims.sid) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + leewaySeconds < now) return null;
  return claims;
}
