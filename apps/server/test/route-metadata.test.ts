import { AUTH_RATE_LIMIT_PREFIXES, BLOCKED_CRAWLER_AGENTS, CSRF_EXEMPT_PREFIXES, delegatedScopesForRoute, isAuthRateLimitedPath, isBlockedCrawler, isOAuthProtocolPath, isProtocolPath, isSeoCrawler, ROBOTS_API_RULES, ROBOTS_PROTOCOL_DISALLOW, ROBOTS_RULES_REVISION } from './../src/core/route-metadata.ts';
import { describe, expect, it } from 'vitest';

describe('shared route metadata', () => {
  it('preserves delegated scope boundaries by method and resource', () => {
    expect(delegatedScopesForRoute('/api/v1/me', 'GET')).toEqual(['User.Read']);
    expect(delegatedScopesForRoute('/api/v1/players/12/textures', 'GET')).toEqual(['Player.Read', 'Player.ReadWrite']);
    expect(delegatedScopesForRoute('/api/v1/players/12', 'DELETE')).toEqual(['Player.ReadWrite']);
    expect(delegatedScopesForRoute('/api/v1/me/notifications', 'PATCH')).toEqual(['Notification.Read', 'Notification.ReadWrite']);
    expect(delegatedScopesForRoute('/api/v1/admin/notifications', 'POST')).toEqual(['Notification.ReadWrite']);
    expect(delegatedScopesForRoute('/api/v1/admin/settings', 'GET')).toBeNull();
    expect(delegatedScopesForRoute('/api/v1/players/12/unknown', 'GET')).toBeNull();
    expect(delegatedScopesForRoute('/api/v1/me', 'POST')).toBeNull();
  });

  it('identifies only existing protocol and OAuth CSRF exemptions', () => {
    for (const path of ['/textures/hash', '/csl/player.json', '/raw/12', '/avatar/name', '/preview/hash', '/player.json']) {
      expect(isProtocolPath(path), path).toBe(true);
    }
    for (const path of ['/api/v1/textures', '/skinlib/player.json/extra', '/yggc/authserver/authenticate']) {
      expect(isProtocolPath(path), path).toBe(false);
    }
    for (const path of ['/oauth/authorize', '/oauth/token', '/yggc/userinfo']) expect(isOAuthProtocolPath(path)).toBe(true);
    for (const path of ['/oauth/admin', '/api/v1/auth/login', '/yggc/authserver/authenticate']) expect(isOAuthProtocolPath(path)).toBe(false);
    expect(CSRF_EXEMPT_PREFIXES).toEqual(['/api/v1/health', '/api/v1/settings/public']);
  });

  it('keeps auth rate-limit prefixes and generated robots rules explicit', () => {
    for (const prefix of AUTH_RATE_LIMIT_PREFIXES) expect(isAuthRateLimitedPath(`${prefix}probe`)).toBe(true);
    expect(isAuthRateLimitedPath('/api/v1/admin/users')).toBe(false);
    expect(ROBOTS_API_RULES).toContain('Disallow: /api/');
    expect(ROBOTS_PROTOCOL_DISALLOW).toEqual(['Disallow: /raw/', 'Disallow: /textures/']);
  });

  it('blocks Claude crawler agents by case-insensitive user-agent substring', () => {
    expect(BLOCKED_CRAWLER_AGENTS).toEqual(['ClaudeBot', 'Claude-SearchBot', 'Claude-Web', 'anthropic-ai']);
    // 精确断言：改动清单时必须同时确认修订号已递增，否则缓存里的旧 robots.txt 不会失效
    expect(ROBOTS_RULES_REVISION).toBe(3);
    for (const ua of [
      'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'Claude-SearchBot/1.0; +claudesearchbot@anthropic.com',
      'Claude-Web/1.0',
      'anthropic-ai',
    ]) expect(isBlockedCrawler(ua), ua).toBe(true);
    // 用户主动让 Claude 读取页面（Claude-User）与正常浏览器、搜索引擎都不拦
    for (const ua of [
      'claude-user/1.0; +claude-user@anthropic.com',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    ]) expect(isBlockedCrawler(ua), ua).toBe(false);
    expect(isBlockedCrawler(undefined)).toBe(false);
    expect(isBlockedCrawler('')).toBe(false);
  });

  it('identifies SEO crawler agents without catching real browsers', () => {
    // 已知爬虫标识与 bot/crawler/spider/slurp 兜底都要命中
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
      'Sogou web spider/4.0(+https://www.sogou.com/docs/help/webmasters.htm#07)',
      'Mozilla/5.0 (compatible; 360Spider; +https://www.so.com/help/help.html)',
      'Mozilla/5.0 (compatible; YisouSpider/5.0; +https://www.yisou.com/spider.html)',
      'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
      'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
      'Mozilla/5.0 (compatible; YandexImages/3.0)',
      'Mozilla/5.0 (compatible; DuckDuckBot/1.0; +http://duckduckgo.com/duckduckbot.html)',
      'Mozilla/5.0 (compatible; BingPreview/1.0b)',
      'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'TelegramBot (like TwitterBot)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    ]) expect(isSeoCrawler(ua), ua).toBe(true);
    // 与爬虫同品牌的真人浏览器（内置浏览器、手机浏览器）绝不能被当成爬虫，
    // 否则快照正文会进用户响应
    for (const ua of [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49',
      'Mozilla/5.0 (Linux; U; Android 14; zh-CN; M2012K11AC Build/UKQ1.230917) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 SogouMobileBrowser/6.7.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SE 2.X MetaSr 1.0',
      'Mozilla/5.0 (Linux; U; Android 14; zh-cn; PGT-AN10 Build/HUAWEIPGT-AN10) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.0.0 Mobile Safari/537.36 MQQBrowser/14.6',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 baiduboxapp/13.42.0.10 (Baidu; P2 17.5)',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 QIHU 360SE',
      'WhatsApp/2.24.12 A',
      'claude-user/1.0; +claude-user@anthropic.com',
      '',
    ]) expect(isSeoCrawler(ua), ua).toBe(false);
    expect(isSeoCrawler(undefined)).toBe(false);
  });
});
