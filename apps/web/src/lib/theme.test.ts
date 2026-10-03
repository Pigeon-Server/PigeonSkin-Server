import { describe, expect, it, vi } from 'vitest';
import { accessibleAccent, onColor, resolveThemeColor, applySiteTheme } from '@/lib/theme';
describe('site theme', () => {
  it('accepts custom colors and the PHP theme palette', () => {
    expect(resolveThemeColor('#abc')).toBe('#aabbcc');
    expect(resolveThemeColor('#8061A8')).toBe('#8061a8');
    expect(resolveThemeColor('navbar-dark navbar-primary')).toBe('#3c6fa5');
    expect(resolveThemeColor('sidebar-dark-purple')).toBe('#8061a8');
    expect(resolveThemeColor('light-indigo')).toBe('#5c59a7');
    expect(resolveThemeColor('url(https://example.com)')).toBeNull();
  });
  it('keeps labels readable on very light and very dark accents', () => {
    expect(onColor('#ffff00')).toBe('#17202b');
    expect(onColor('#131720')).toBe('#ffffff');
    expect(accessibleAccent('#ffff00', false)).not.toBe('#ffff00');
    expect(accessibleAccent('#131720', true)).not.toBe('#131720');
  });
  it('keeps normal and hovered theme buttons readable across midtones and both surfaces', () => {
    function luminance(hex: string) {
      const values = [1, 3, 5].map(start => Number.parseInt(hex.slice(start, start + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
    }
    const variables = new Map<string, string>();
    vi.stubGlobal('document', { documentElement: { style: { setProperty: (name: string, value: string) => variables.set(name, value), removeProperty: (name: string) => variables.delete(name) } } });
    try {
      for (const dark of [false, true]) for (const theme_color of ['#52647a', '#777777', '#888888', '#ffcc00', '#ffffff', '#000000', '#ff0000', '#00ff00', '#0000ff']) {
        applySiteTheme({ theme_color }, dark);
        for (const [background, foreground] of [['--brand-base', '--brand-ink'], ['--brand-hover', '--brand-hover-ink']]) {
          const a = luminance(variables.get(background!)!), b = luminance(variables.get(foreground!)!);
          expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), `${theme_color} ${background}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    } finally { vi.unstubAllGlobals(); }
  });
});
