const requestedLanguage = new URLSearchParams(location.search).get('site_lang');
if (requestedLanguage) {
  const aliases = { 'zh-cn': 'zh', 'zh-tw': 'zh_tw' };
  const code = aliases[requestedLanguage.toLowerCase()] || requestedLanguage.split('-')[0].toLowerCase();
  const supported = new Set(['en', 'ar', 'cz', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'pt_br', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh', 'zh_tw']);
  if (supported.has(code)) {
    window.__editorPreviousSettings = localStorage.getItem('settings');
    let settings = {};
    try { settings = JSON.parse(window.__editorPreviousSettings || '{}') || {}; } catch { /* 解析失败按空设置处理 */ }
    settings.language = { ...(settings.language || {}), value: code };
    localStorage.setItem('settings', JSON.stringify(settings));
  }
}
