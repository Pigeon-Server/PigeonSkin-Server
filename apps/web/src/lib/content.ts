export function decodeLegacyContent(value: string): string {
  return value.replace(/\\+r\\+n/g, '\n');
}
