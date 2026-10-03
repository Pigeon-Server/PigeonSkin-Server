import { describe, expect, it } from 'vitest';
import { integrationModules, integrationModuleForPlugin } from '@/lib/integrations';
import { zh_CN as zh, en } from '@/locales';
describe('built-in feature navigation', () => {
  it('maps configurable built-in features without creating manual protocol workflows', () => {
    const plugins = [
      'google-adsense',
      'gtag-js',
      'config-generator',
      'mojang-verification',
      'oauth',
      'oauth-github',
      'oauth-littleskin',
      'oauth-microsoft-live',
      'restricted-email-domains',
      'texture-description',
      'yggdrasil-api',
      'yggdrasil-connect',
      'pigeon-skin_api',
      'pigeon-skin_vote',
    ];
    expect(integrationModules.flatMap((module) => [...module.plugins]).sort()).toEqual(
      plugins.sort(),
    );
    for (const plugin of plugins) expect(integrationModuleForPlugin(plugin)).toBeDefined();
    expect(integrationModuleForPlugin('legacy-api')).toBeUndefined();
    expect(integrationModuleForPlugin('usm-api')).toBeUndefined();
    expect(integrationModuleForPlugin('unknown')).toBeUndefined();
  });
  it('provides labels and business help for every editable feature setting in both languages', () => {
    for (const locale of [zh, en])
      for (const module of integrationModules) {
        expect(locale.integration.modules[module.id]).toBeTruthy();
        for (const key of module.keys) {
          expect(locale.integration.help[key]).toBeTruthy();
          expect(locale.admin.setting[key]).toBeTruthy();
        }
      }
  });
});
