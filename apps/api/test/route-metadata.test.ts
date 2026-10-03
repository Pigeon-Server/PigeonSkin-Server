import { describe, expect, it } from 'vitest';
import {
  AUTH_RATE_LIMIT_PREFIXES,
  CSRF_EXEMPT_PREFIXES,
  ROBOTS_API_RULES,
  ROBOTS_PROTOCOL_DISALLOW,
  delegatedScopesForRoute,
  isAuthRateLimitedPath,
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
});
