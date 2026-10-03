function der(tag: number, content: Uint8Array): Uint8Array {
  const size = content.length;
  const length = size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >> 8, size & 255];
  return new Uint8Array([tag, ...length, ...content]);
}
export function privateKeyBytes(pem: string): Uint8Array {
  const encoded = pem.replace(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s+/g,
    '',
  );
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  if (!pem.includes('BEGIN RSA PRIVATE KEY')) return bytes;
  return der(
    0x30,
    new Uint8Array([
      2,
      1,
      0,
      0x30,
      0x0d,
      6,
      9,
      0x2a,
      0x86,
      0x48,
      0x86,
      0xf7,
      0x0d,
      1,
      1,
      1,
      5,
      0,
      ...der(4, bytes),
    ]),
  );
}
export async function inspectSigningKey(pem: string) {
  if (!pem.trim())
    return { configured: false, valid: false, bits: 0, publicKey: null, fingerprint: null };
  try {
    const bytes = privateKeyBytes(pem);
    const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' };
    const privateKey = await crypto.subtle.importKey('pkcs8', bytes, algorithm, true, ['sign']);
    const bits = (privateKey.algorithm as { modulusLength: number }).modulusLength;
    if (bits < 4096)
      return { configured: true, valid: false, bits, publicKey: null, fingerprint: null };
    const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as { n: string; e: string };
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n!, e: jwk.e!, ext: true },
      algorithm,
      true,
      ['verify'],
    );
    const spki = new Uint8Array((await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer);
    const base64 = btoa(String.fromCharCode(...spki));
    const fingerprint = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', spki)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join(':');
    return {
      configured: true,
      valid: true,
      bits,
      publicKey: `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`,
      fingerprint,
    };
  } catch {
    return { configured: true, valid: false, bits: 0, publicKey: null, fingerprint: null };
  }
}
