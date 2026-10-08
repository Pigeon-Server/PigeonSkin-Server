// captcha 家族共享的 Web Crypto 工具：SHA-256 摘要与 HMAC-SHA256 签名。
// Web Crypto 在 Workers 与 Node 上行为一致。

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

export async function hmacSha256(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value))));
}
