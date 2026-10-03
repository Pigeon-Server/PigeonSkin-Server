export function scopeKey(scope: string) {
  const identity: Record<string, string> = { openid: 'identity', profile: 'profile', email: 'email', offline_access: 'offline', 'Yggdrasil.PlayerProfiles.Read': 'profiles', 'Yggdrasil.PlayerProfiles.Select': 'select', 'Yggdrasil.Server.Join': 'join' };
  return identity[scope] ? `connect.scopes.${identity[scope]}` : `oauth.scopes.${scope.replace('.', '_')}`;
}
