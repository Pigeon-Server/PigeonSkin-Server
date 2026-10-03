export async function generateSigningKey(): Promise<string> {
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-512',
    },
    true,
    ['sign', 'verify'],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const encoded = btoa(String.fromCharCode(...bytes));
  return `-----BEGIN PRIVATE KEY-----\n${encoded.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
}
