import { describe, expect, it } from 'vitest';
import { createSkinConfigs, launcherUri } from '@/lib/skin-config';
describe('PHP configuration generator contracts', () => {
  it('generates a complete site-first CSL configuration with Mojang fallback', () => {
    expect(createSkinConfigs('皮肤站', 'https://skin.example.com', 'self').csl).toEqual({
      enable: true,
      loadlist: [
        { name: '皮肤站', root: 'https://skin.example.com/csl/', type: 'CustomSkinAPI' },
        { name: 'Mojang', type: 'MojangAPI' },
      ],
    });
  });
  it('honors Mojang-first priority without removing the site fallback', () => {
    const configuration = createSkinConfigs('Skin site', 'https://skin.example.com', 'mojang');
    expect(configuration.csl.loadlist.map((entry) => entry.type)).toEqual([
      'MojangAPI',
      'CustomSkinAPI',
    ]);
  });
  it('generates USM and ExtraList without requiring individual player URLs', () => {
    const configuration = createSkinConfigs('Skin site', 'https://skin.example.com', 'self');
    expect(configuration.usm).toEqual({
      rootURIs: ['https://skin.example.com/usm/'],
      legacySkinURIs: [],
      legacyCapeURIs: [],
    });
    expect(configuration.extraList).toEqual({
      name: 'Skin site',
      type: 'CustomSkinAPI',
      root: 'https://skin.example.com/csl/',
    });
  });
  it('matches the PHP launcher drag protocol while retaining the plain clipboard URL', () => {
    expect(launcherUri('https://skin.example.com/api/yggdrasil')).toBe(
      'authlib-injector:yggdrasil-server:https%3A%2F%2Fskin.example.com%2Fapi%2Fyggdrasil',
    );
  });
});
