import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('scrollbar styles', () => {
  const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf-8');

  it('declares custom scrollbar CSS variables for light and dark themes', () => {
    expect(css).toContain('--scrollbar-size: 10px;');
    expect(css).toContain('--scrollbar-size-thin: 6px;');
    expect(css).toContain('--scrollbar-track: transparent;');
    expect(css).toContain('--scrollbar-thumb: color-mix(');
    expect(css).toContain('--scrollbar-thumb-hover:');
    expect(css).toContain('--scrollbar-thumb-active:');
  });

  it('implements standard scrollbar-color and modern WebKit pseudo-elements', () => {
    expect(css).toContain('scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);');
    expect(css).toContain('scrollbar-width: thin;');
    expect(css).toContain('*::-webkit-scrollbar');
    expect(css).toContain('*::-webkit-scrollbar-thumb');
    expect(css).toContain('*::-webkit-scrollbar-track');
    expect(css).toContain('*::-webkit-scrollbar-corner');
    expect(css).toContain('*::-webkit-scrollbar-button');
  });

  it('provides utility classes for hidden, thin and hover-only scrollbars', () => {
    expect(css).toContain('.scrollbar-thin');
    expect(css).toContain('.scrollbar-none');
    expect(css).toContain('.no-scrollbar');
    expect(css).toContain('.scrollbar-hover');
  });

  it('handles accessibility with high contrast media query and layout stability', () => {
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('scrollbar-gutter: stable;');
  });
});
