import { base64url } from 'jose';
import { AppError } from '../framework.ts';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Uint8Array): string {
  let value = 0, bits = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
export function decodeBase32(input: string): Uint8Array {
  let value = 0, bits = 0;
  const output: number[] = [];
  for (const letter of input.replace(/=+$/, '').toUpperCase()) {
    const digit = alphabet.indexOf(letter);
    if (digit < 0) throw new Error('Invalid base32');
    value = (value << 5) | digit; bits += 5;
    if (bits >= 8) { bits -= 8; output.push((value >>> bits) & 255); }
  }
  return new Uint8Array(output);
}
export async function totp(secret: string, step: number, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey('raw', decodeBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = mac[mac.length - 1]! & 15;
  const value = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
  return String(value % 10 ** digits).padStart(digits, '0');
}
export async function matchingStep(secret: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) if (await totp(secret, step) === code) return step;
  return null;
}
async function encryptionKey(secret: string | undefined) {
  let bytes: Uint8Array;
  try { bytes = base64url.decode(secret || ''); } catch { throw new AppError('security.unavailable', 503); }
  if (bytes.length !== 32) throw new AppError('security.unavailable', 503);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(secret: string, key: string | undefined, userId: number) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(String(userId)) }, await encryptionKey(key), new TextEncoder().encode(secret));
  return `${base64url.encode(iv)}.${base64url.encode(new Uint8Array(data))}`;
}
export async function decryptSecret(value: string, key: string | undefined, userId: number) {
  const parts = value.split('.');
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64url.decode(parts[0]!), additionalData: new TextEncoder().encode(String(userId)) }, await encryptionKey(key), base64url.decode(parts[1]!));
    return new TextDecoder().decode(plaintext);
  } catch { throw new AppError('security.unavailable', 503); }
}
export const randomToken = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
export function emailCode() {
  const limit = Math.floor(0x100000000 / 1000000) * 1000000;
  let value: number;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]!; } while (value >= limit);
  return String(value % 1000000).padStart(6, '0');
}
