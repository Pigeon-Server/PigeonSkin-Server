import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '@/lib/signing-key';
describe('browser signing key generation', () => {
  it('generates an importable RSA private key meeting the Minecraft signing requirement', async () => {
    const pem = await generateSigningKey();
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const encoded = pem.replace(/-----[^-]+-----|\s+/g, '');
    const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(encoded), value => value.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, false, ['sign']);
    expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(4096);
  }, 15000);
});
