/**
 * 站点配置字段的联动可见性规则：只有当字段对运行行为有影响时才显示。
 * 输入取自 Settings 页的加载值与未保存编辑值（编辑值优先），输出该键是否可见。
 */
export interface SettingVisibilityInput {
  /** 已保存值（缺省键按空串处理） */
  values: Record<string, string | undefined>;
  /** 未保存编辑值，优先于 values */
  edits?: Record<string, string | undefined>;
  /** 服务端按部署 env 算出的 AI 生效驱动（ai_driver 留空时的回退） */
  aiEffectiveDriver?: string | undefined;
}

export function isSettingVisible(key: string, input: SettingVisibilityInput): boolean {
  const valueOf = (name: string) => input.edits?.[name] ?? input.values[name] ?? '';
  const flagOn = (name: string) => valueOf(name) === 'true';
  const aiDriver = () => valueOf('ai_driver') || input.aiEffectiveDriver || '';
  const taskMode = (modeKey: string) => valueOf(modeKey);

  // 任一审核任务走判别模式（或判别驱动生效）时判别凭据/阈值才有意义
  const discriminativeModeSelected = (driver: string) =>
    taskMode('ai_comments_moderation_mode') === 'discriminative' ||
    taskMode('ai_texture_moderate_mode') === 'discriminative' ||
    driver === 'systemone';

  // AI 驱动联动：凭据/地址字段只在会用到的驱动下显示；"跟随部署"时以
  // 服务端算出的生效驱动为准（Workers AI 绑定下没有任何 API 字段可填）。
  if (key === 'openai_base_url') return aiDriver() === 'openai';
  if (key === 'ai_api_key') return ['openai', 'anthropic'].includes(aiDriver());
  // 思考模式参数只被 OpenAI 兼容端点消费（Qwen3/vLLM 语义）
  if (key === 'ai_reasoning') return aiDriver() === 'openai';
  // 判别模型凭据：TypeSafe Key 在任一审核任务走判别模式或驱动为 systemone 时显示；
  // Cloudflare REST 凭据同理，但 Workers AI 绑定可用的部署走绑定调用，不需要它们。
  if (key === 'ai_systemone_api_key') {
    return discriminativeModeSelected(aiDriver());
  }
  if (key === 'ai_cloudflare_account_id' || key === 'ai_cloudflare_api_token') {
    if (aiDriver() === 'workers') return false;
    return discriminativeModeSelected(aiDriver());
  }
  // 判别阈值只在有任务走判别模式时生效
  if (key === 'ai_discriminative_threshold') return discriminativeModeSelected(aiDriver());

  // 验证码驱动联动：凭据字段只在需要凭据的驱动下显示（image 自绘无凭据），
  // v3 阈值仅 v3，阿里 AccessKey ID 仅 aliyun（AccessKeySecret 复用 captcha_secret）。
  if (['captcha_site_key', 'captcha_secret', 'recaptcha_v3_threshold', 'aliyun_captcha_access_key_id'].includes(key)) {
    const captchaDriver = valueOf('captcha_driver');
    if (!captchaDriver || captchaDriver === 'image') return false;
    if (key === 'recaptcha_v3_threshold') return captchaDriver === 'recaptcha_v3';
    if (key === 'aliyun_captcha_access_key_id') return captchaDriver === 'aliyun';
    return true;
  }

  // 发信方式联动：SMTP 字段只在 smtp 驱动下显示，Resend 密钥只在 resend 下显示
  if (['smtp_host', 'smtp_port', 'smtp_encryption', 'smtp_username', 'smtp_password'].includes(key)) {
    return valueOf('mail_driver') === 'smtp';
  }
  if (key === 'resend_api_key') return valueOf('mail_driver') !== 'smtp';

  // AI 网关联动：并发/超时在有任一功能启用时才需要；各功能的模型/提示词
  // 覆盖只在对应功能开启时生效（评论审核还依赖评论区本身开启）。
  if (key === 'ai_max_concurrency' || key === 'ai_timeout_seconds') {
    return flagOn('texture_ai_translation') || flagOn('texture_ai_moderation') || flagOn('comments_ai_moderation');
  }
  if (key.startsWith('ai_texture_translate_')) return flagOn('texture_ai_translation');
  if (key.startsWith('ai_texture_moderate_')) {
    const featureOn = flagOn('texture_ai_moderation');
    if (key === 'ai_texture_moderate_mode') return featureOn;
    // 模型/提示词始终可见：判别模式下模型可切换 Jev/Clef，提示词改作
    // unsafe 问题的 instructions 覆盖。翻译任务的模型/提示词保持原联动。
    return featureOn;
  }
  if (key.startsWith('ai_comments_moderation_')) {
    const featureOn = flagOn('comments_ai_moderation') && flagOn('comments_enabled');
    return featureOn;
  }

  // 注册联动：注册关闭后未参与其他流程的注册项不再显示。
  // require_email_verification 不联动——它还决定存量用户能否通过
  // Yggdrasil/Connect 鉴权；register_with_player_name 不联动——OAuth 账户
  // 初始化仍按它要求填玩家名，两者都不受 registration_enabled 控制。
  // 玩家名规则同理：创建角色仍用。自定义正则只参与 custom 规则的校验。
  if (key === 'regs_per_ip') return flagOn('registration_enabled');
  if (key === 'player_name_regexp') return valueOf('player_name_rule') === 'custom';

  // 下载联动：整站关闭下载后匿名下载无作用域
  if (key === 'allow_anonymous_download') return flagOn('allow_texture_download');

  // 首页背景联动：未设置任何背景图时固定背景无效果
  if (key === 'home_fixed_background') {
    return ['home_background_url', 'home_background_tablet_url', 'home_background_mobile_url']
      .some((name) => valueOf(name).trim() !== '');
  }
  return true;
}
