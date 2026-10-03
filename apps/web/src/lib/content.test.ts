import { describe, expect, it } from 'vitest';
import { decodeLegacyContent } from '@/lib/content';
describe('legacy content', () => {
  it('decodes escaped CRLF from one or two import layers', () => {
    expect(decodeLegacyContent(String.raw`A\r\nB`)).toBe('A\nB');
    expect(decodeLegacyContent(String.raw`A\\r\\nB`)).toBe('A\nB');
    expect(decodeLegacyContent('A\r\nB')).toBe('A\r\nB');
  });
  it('preserves ordinary backslashes and code escapes', () => {
    expect(decodeLegacyContent(String.raw`const newline = "\n";`)).toBe(String.raw`const newline = "\n";`);
  });
});
