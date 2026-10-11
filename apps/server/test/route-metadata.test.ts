import { describe, expect, it } from 'vitest';
import {
  AUTH_RATE_LIMIT_PREFIXES,
  BLOCKED_CRAWLER_AGENTS,
  CSRF_EXEMPT_PREFIXES,
  ROBOTS_API_RULES,
  ROBOTS_PROTOCOL_DISALLOW,
  ROBOTS_RULES_REVISION,
  delegatedScopesForRoute,
  isAuthRateLimitedPath,
  isBlockedCrawler,
  isOAuthProtocolPath,
  isProtocolPath,
} from '../src/route-metadata.ts';

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
});
