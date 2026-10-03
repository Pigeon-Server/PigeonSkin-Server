export const integrationModules = [
  { id: 'resources', icon: 'collections', plugins: [], keys: ['official_resources_auto_update'] },
  { id: 'pigeon', icon: 'vpn_key', plugins: ['pigeon-skin_api'], keys: ['pigeon_api_window_seconds', 'pigeon_api_request_limit'] },
  { id: 'votes', icon: 'how_to_vote', plugins: ['pigeon-skin_vote'], keys: ['votes_enabled'] },
  {
    id: 'oauth',
    icon: 'login',
    plugins: ['oauth', 'oauth-github', 'oauth-littleskin', 'oauth-microsoft-live'],
    keys: ['oauth_enabled', 'github_client_id', 'github_client_secret', 'littleskin_client_id', 'littleskin_client_secret', 'littleskin_api_root', 'microsoft_client_id', 'microsoft_client_secret'],
  },
  {
    id: 'mojang',
    icon: 'verified_user',
    plugins: ['mojang-verification'],
    keys: ['mojang_verification_score_award', 'mojang_client_id', 'mojang_client_secret'],
  },
  {
    id: 'yggdrasil',
    icon: 'key',
    plugins: ['yggdrasil-api', 'yggdrasil-connect'],
    keys: [
      'ygg_uuid_algorithm',
      'ygg_token_expire_1',
      'ygg_token_expire_2',
      'ygg_tokens_limit',
      'ygg_rate_limit',
      'ygg_skin_domain',
      'ygg_search_profile_max',
      'ygg_show_config_section',
      'ygg_enable_ali',
      'ygg_connect_enabled',
      'ygg_disable_authserver',
    ],
  },
  { id: 'generator', icon: 'description', plugins: ['config-generator'], keys: ['csl_first', 'config_generator_intro'] },
  {
    id: 'email',
    icon: 'alternate_email',
    plugins: ['restricted-email-domains'],
    keys: ['restricted_email_allow', 'restricted_email_deny'],
  },
  {
    id: 'description',
    icon: 'notes',
    plugins: ['texture-description'],
    keys: ['textures_description_limit'],
  },
  { id: 'adsense', icon: 'ads_click', plugins: ['google-adsense'], keys: ['adsense_client_id'] },
  { id: 'analytics', icon: 'analytics', plugins: ['gtag-js'], keys: ['gtag_id'] },
  { id: 'search', icon: 'travel_explore', plugins: [], keys: ['search_google_enabled', 'search_google_property', 'search_google_credentials', 'search_bing_enabled', 'search_bing_key', 'search_baidu_enabled', 'search_baidu_token'] },
] as const;
export function integrationModuleForPlugin(plugin: string) {
  return integrationModules.find((module) => (module.plugins as readonly string[]).includes(plugin))
    ?.id;
}
