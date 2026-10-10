import { describe, expect, it } from 'vitest';
import { isSettingVisible } from '@/lib/setting-visibility';

const base = { values: {}, edits: undefined, aiEffectiveDriver: '' } as const;

function visible(key: string, values: Record<string, string>, aiEffectiveDriver = ''): boolean {
  return isSettingVisible(key, { values, aiEffectiveDriver });
}

describe('setting visibility rules', () => {
  it('hides credential fields unless the AI driver consumes them', () => {
    // 跟随部署：以服务端生效驱动为准
    expect(visible('openai_base_url', {}, 'openai')).toBe(true);
    expect(visible('openai_base_url', {}, 'anthropic')).toBe(false);
    expect(visible('openai_base_url', { ai_driver: 'openai' })).toBe(true);
    // Workers AI 无 API 字段可填
    expect(visible('ai_api_key', {}, 'workers')).toBe(false);
    expect(visible('ai_api_key', { ai_driver: 'anthropic' })).toBe(true);
    // 未保存的编辑值优先于已保存值
    expect(visible('ai_api_key', { ai_driver: '' }, 'workers')).toBe(false);
    expect(isSettingVisible('ai_api_key', { ...base, values: { ai_driver: '' }, edits: { ai_driver: 'openai' }, aiEffectiveDriver: 'workers' })).toBe(true);
  });

  it('shows ai_reasoning only for the OpenAI-compatible driver', () => {
    expect(visible('ai_reasoning', { ai_driver: 'openai' })).toBe(true);
    expect(visible('ai_reasoning', { ai_driver: 'anthropic' })).toBe(false);
    expect(visible('ai_reasoning', {}, 'workers')).toBe(false);
  });

  it('shows mode selectors with their feature switch and keeps model/prompt fields visible in both modes', () => {
    // 模式选择器跟随功能开关
    expect(visible('ai_comments_moderation_mode', {})).toBe(false);
    expect(visible('ai_comments_moderation_mode', { comments_ai_moderation: 'true', comments_enabled: 'true' })).toBe(true);
    expect(visible('ai_texture_moderate_mode', { texture_ai_moderation: 'true' })).toBe(true);
    // 模型/提示词在两种模式下都可见：判别模式下模型可切 Jev/Clef、提示词改作判定说明
    expect(visible('ai_comments_moderation_model', { comments_ai_moderation: 'true', comments_enabled: 'true', ai_driver: 'openai' })).toBe(true);
    expect(visible('ai_comments_moderation_model', { comments_ai_moderation: 'true', comments_enabled: 'true', ai_driver: 'systemone' })).toBe(true);
    expect(visible('ai_comments_moderation_model', { comments_ai_moderation: 'true', comments_enabled: 'true', ai_comments_moderation_mode: 'discriminative' })).toBe(true);
    expect(visible('ai_texture_moderate_prompt', { texture_ai_moderation: 'true', ai_texture_moderate_mode: 'discriminative' })).toBe(true);
  });

  it('shows discriminative credentials and threshold only when discriminative mode is in play', () => {
    // 无任何判别配置时隐藏
    expect(visible('ai_systemone_api_key', {})).toBe(false);
    expect(visible('ai_cloudflare_account_id', {})).toBe(false);
    expect(visible('ai_discriminative_threshold', {})).toBe(false);
    // 任务显式选判别模式时显示
    expect(visible('ai_systemone_api_key', { ai_comments_moderation_mode: 'discriminative' })).toBe(true);
    expect(visible('ai_discriminative_threshold', { ai_texture_moderate_mode: 'discriminative' })).toBe(true);
    // 判别驱动生效时也显示
    expect(visible('ai_systemone_api_key', { ai_driver: 'systemone' })).toBe(true);
    // Cloudflare REST 凭据在 workers 驱动下无作用（Clef 走 AI 绑定）
    expect(visible('ai_cloudflare_account_id', { ai_driver: 'workers' })).toBe(false);
    expect(visible('ai_cloudflare_account_id', { ai_comments_moderation_mode: 'discriminative' })).toBe(true);
    expect(visible('ai_cloudflare_api_token', { ai_texture_moderate_mode: 'discriminative' })).toBe(true);
  });

  it('shows captcha credentials per driver', () => {
    expect(visible('captcha_site_key', { captcha_driver: '' })).toBe(false);
    expect(visible('captcha_secret', { captcha_driver: 'image' })).toBe(false);
    expect(visible('captcha_site_key', { captcha_driver: 'turnstile' })).toBe(true);
    expect(visible('recaptcha_v3_threshold', { captcha_driver: 'recaptcha_v3' })).toBe(true);
    expect(visible('recaptcha_v3_threshold', { captcha_driver: 'recaptcha_v2' })).toBe(false);
    expect(visible('aliyun_captcha_access_key_id', { captcha_driver: 'aliyun' })).toBe(true);
    expect(visible('aliyun_captcha_access_key_id', { captcha_driver: 'tencent' })).toBe(false);
  });

  it('shows SMTP fields only under the smtp driver', () => {
    expect(visible('smtp_host', { mail_driver: 'smtp' })).toBe(true);
    expect(visible('smtp_host', { mail_driver: 'resend' })).toBe(false);
    expect(visible('resend_api_key', { mail_driver: 'resend' })).toBe(true);
    expect(visible('resend_api_key', { mail_driver: 'smtp' })).toBe(false);
  });

  it('gates AI gateway fields on their feature switches', () => {
    expect(visible('ai_max_concurrency', {})).toBe(false);
    expect(visible('ai_timeout_seconds', { comments_ai_moderation: 'true' })).toBe(true);
    expect(visible('ai_texture_translate_model', { texture_ai_translation: 'true' })).toBe(true);
    expect(visible('ai_texture_translate_prompt', {})).toBe(false);
    expect(visible('ai_texture_moderate_model', { texture_ai_moderation: 'true' })).toBe(true);
    // 评论审核模型还依赖评论区本身开启
    expect(visible('ai_comments_moderation_model', { comments_ai_moderation: 'true', comments_enabled: 'false' })).toBe(false);
    expect(visible('ai_comments_moderation_model', { comments_ai_moderation: 'true', comments_enabled: 'true' })).toBe(true);
  });

  it('hides regs_per_ip when registration is disabled but keeps fields that serve existing users', () => {
    expect(visible('regs_per_ip', { registration_enabled: 'false' })).toBe(false);
    expect(visible('regs_per_ip', { registration_enabled: 'true' })).toBe(true);
    // 邮箱验证仍决定存量用户能否通过 Yggdrasil/Connect 鉴权
    expect(visible('require_email_verification', { registration_enabled: 'false' })).toBe(true);
    // OAuth 账户初始化仍按它要求填玩家名
    expect(visible('register_with_player_name', { registration_enabled: 'false' })).toBe(true);
  });

  it('shows the custom player-name regexp only under the custom rule', () => {
    expect(visible('player_name_regexp', { player_name_rule: 'official' })).toBe(false);
    expect(visible('player_name_regexp', { player_name_rule: 'custom' })).toBe(true);
  });

  it('hides anonymous download when texture download is off', () => {
    expect(visible('allow_anonymous_download', { allow_texture_download: 'false' })).toBe(false);
    expect(visible('allow_anonymous_download', { allow_texture_download: 'true' })).toBe(true);
  });

  it('shows home_fixed_background only when a background image is set', () => {
    expect(visible('home_fixed_background', {})).toBe(false);
    expect(visible('home_fixed_background', { home_background_url: ' ' })).toBe(false);
    expect(visible('home_fixed_background', { home_background_tablet_url: 'https://x/y.png' })).toBe(true);
  });

  it('shows unrelated fields unconditionally', () => {
    expect(visible('site_name', {})).toBe(true);
    expect(visible('initial_score', {})).toBe(true);
    expect(visible('icp_beian', {})).toBe(true);
  });
});
