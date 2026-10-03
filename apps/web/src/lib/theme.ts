export const DEFAULT_THEME_COLOR = '#52647a';
const legacyColors: Record<string, string> = {
  primary: '#3c6fa5',
  secondary: '#6c757d',
  success: '#2e8b57',
  info: '#328aa0',
  warning: '#e4ad36',
  danger: '#c94747',
  light: '#f5f6f8',
  dark: '#252b35',
  white: '#ffffff',
  black: '#171a20',
  indigo: '#5c59a7',
  purple: '#8061a8',
  pink: '#cb7192',
  navy: '#263e62',
  blue: '#3c6fa5',
  cyan: '#328aa0',
  teal: '#368d8a',
  olive: '#598658',
  lime: '#8ca847',
  orange: '#c48335',
  fuchsia: '#b760a2',
  maroon: '#944c64',
  gray: '#6c757d',
};
export function resolveThemeColor(value: string): string | null {
  const input = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(input)) return input;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(input);
  if (short)
    return (
      '#' +
      short
        .slice(1)
        .map((part) => part + part)
        .join('')
    );
  if (legacyColors[input]) return legacyColors[input];
  const legacy = /^(?:light|dark)-([a-z]+)$/.exec(input);
  if (legacy) return legacyColors[legacy[1]!] ?? null;
  const tokens = input
    .split(/\s+/)
    .map((part) => part.match(/^(?:navbar|sidebar)-(?:dark-|light-)?([a-z]+)$/)?.[1]);
  const token = tokens.reverse().find((part) => part && legacyColors[part]);
  return token ? (legacyColors[token] ?? null) : null;
}
function rgb(color: string) {
  return [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
}
function luminance(color: string) {
  const values = rgb(color).map((value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
}
function mix(color: string, target: string, amount: number) {
  const a = rgb(color),
    b = rgb(target);
  return (
    '#' +
    a
      .map((v, i) =>
        Math.round(v + (b[i]! - v) * amount)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
export function onColor(color: string) {
  const light = luminance(color);
  if (1.05 / (light + 0.05) >= 4.5) return '#ffffff';
  return (light + 0.05) / (luminance('#17202b') + 0.05) >= 4.5 ? '#17202b' : '#000000';
}
export function accessibleAccent(color: string, dark: boolean) {
  const surface = dark ? '#181b20' : '#ffffff';
  const target = dark ? '#ffffff' : '#000000';
  let result = color;
  for (let step = 0; step <= 20; step++) {
    result = mix(color, target, step / 20);
    const a = luminance(result),
      b = luminance(surface);
    if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5) break;
  }
  return result;
}
export function applySiteTheme(settings: Record<string, string>, dark: boolean) {
  const color = resolveThemeColor(settings.theme_color || '') || DEFAULT_THEME_COLOR;
  const hover = mix(color, '#000000', 0.15);
  const styles = document.documentElement.style;
  const variables: Record<string, string> = {
    '--brand-base': color,
    '--brand-hover': hover,
    '--brand-hover-ink': onColor(hover),
    '--brand-ink': onColor(color),
    '--brand': accessibleAccent(color, dark),
    '--brand-soft': `color-mix(in srgb, ${color} 12%, var(--v0-surface))`,
    '--brand-deep': mix(color, '#000000', 0.6),
  };
  for (const [name, value] of Object.entries(variables)) styles.setProperty(name, value);
  for (const [setting, prefix] of [
    ['navbar_color', 'navbar'],
    ['sidebar_color', 'sidebar'],
  ] as const) {
    const sidebarPreset =
      prefix === 'sidebar'
        ? /^(?:sidebar-)?(light|dark)-([a-z]+)$/.exec(settings[setting] || '')
        : null;
    styles.removeProperty('--sidebar-active-bg');
    styles.removeProperty('--sidebar-active-ink');
    if (sidebarPreset && legacyColors[sidebarPreset[2]!]) {
      const accent = legacyColors[sidebarPreset[2]!]!;
      const forceDark = sidebarPreset[1] === 'dark';
      styles.setProperty('--sidebar-bg', forceDark ? '#252b35' : 'var(--v0-surface)');
      styles.setProperty('--sidebar-ink', forceDark ? '#ffffff' : 'var(--ink)');
      styles.setProperty('--sidebar-muted', forceDark ? '#c2cad5' : 'var(--v0-muted)');
      styles.setProperty(
        '--sidebar-active-bg',
        forceDark ? accent : `color-mix(in srgb, ${accent} 12%, var(--v0-surface))`,
      );
      styles.setProperty(
        '--sidebar-active-ink',
        forceDark ? onColor(accent) : accessibleAccent(accent, dark),
      );
      continue;
    }
    const background = resolveThemeColor(settings[setting] || '');
    for (const variable of ['bg', 'ink', 'muted']) styles.removeProperty(`--${prefix}-${variable}`);
    if (!background) {
      if (prefix === 'navbar' && settings.transparent_navbar === 'true')
        styles.setProperty('--navbar-bg', 'color-mix(in srgb, var(--canvas) 88%, transparent)');
      continue;
    }
    const ink = onColor(background);
    styles.setProperty(
      `--${prefix}-bg`,
      prefix === 'navbar' && settings.transparent_navbar === 'true'
        ? `color-mix(in srgb, ${background} 88%, transparent)`
        : background,
    );
    styles.setProperty(`--${prefix}-ink`, ink);
    styles.setProperty(`--${prefix}-muted`, mix(ink, background, 0.3));
  }
}
