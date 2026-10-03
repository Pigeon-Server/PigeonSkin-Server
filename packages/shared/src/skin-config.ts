export function createSkinConfigs(siteName: string, baseUrl: string, priority: 'self' | 'mojang') {
  const site = { name: siteName, root: new URL('/csl/', baseUrl).href, type: 'CustomSkinAPI' };
  const mojang = { name: 'Mojang', type: 'MojangAPI' };
  return {
    csl: { enable: true, loadlist: priority === 'self' ? [site, mojang] : [mojang, site] },
    usm: { rootURIs: [new URL('/usm/', baseUrl).href], legacySkinURIs: [], legacyCapeURIs: [] },
    extraList: { name: siteName, type: 'CustomSkinAPI', root: site.root },
  };
}
export function launcherUri(apiRoot: string) {
  return `authlib-injector:yggdrasil-server:${encodeURIComponent(apiRoot)}`;
}
