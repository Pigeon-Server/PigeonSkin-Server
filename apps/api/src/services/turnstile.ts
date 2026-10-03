// Turnstile 人机校验。
//
// **必须服务端校验**：只在前端检查等于没检查，攻击者直接调 API 就绕过了。
// 这正是旧版 reCAPTCHA 集成做对的一点（Rules/Captcha 会向 Google 发请求验证），
// 这里保留该性质。
//
// 失败策略是**非对称**的，取决于端点的可滥用程度：
//   • 注册、找回密码：失败**关闭** —— 两者都易被滥用，而正常用户几秒后重试即可
//   • 登录升级校验：失败**开放** —— 第三方故障时把全体用户锁在门外，比失去
//     验证码升级更糟

export interface TurnstileEnv {
  TURNSTILE_SECRET?: string | undefined;
  TURNSTILE_ENABLED?: string | undefined;
}

export type TurnstileVerdict = 'ok' | 'failed' | 'unavailable' | 'disabled';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function isTurnstileEnabled(env: TurnstileEnv): boolean {
  if (env.TURNSTILE_ENABLED === 'false' || env.TURNSTILE_ENABLED === '0') return false;
  return typeof env.TURNSTILE_SECRET === 'string' && env.TURNSTILE_SECRET.length > 0;
}

/**
 * 校验一个 Turnstile token。
 *
 * token 有效期 300 秒且只能验证一次（平台强制），所以不需要自己做防重放。
 */
export async function verifyTurnstile(
  env: TurnstileEnv,
  token: string | undefined,
  remoteIp: string,
): Promise<TurnstileVerdict> {
  if (!isTurnstileEnabled(env)) return 'disabled';
  if (!token) return 'failed';

  try {
    const body = new FormData();
    body.set('secret', env.TURNSTILE_SECRET!);
    body.set('response', token);
    if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

    const response = await fetch(VERIFY_URL, { method: 'POST', body });
    if (!response.ok) return 'unavailable';

    const result = await response.json() as { success?: boolean };
    return result.success === true ? 'ok' : 'failed';
  } catch {
    // 网络层失败与"校验不通过"是两回事：前者应该 fail-open，
    // 否则 Cloudflare 的短暂抖动会让所有人无法注册。
    return 'unavailable';
  }
}

/**
 * 把校验结果转成是否放行。
 * @param failOpen 校验服务不可用时是否放行。注册类端点传 false，登录传 true。
 */
export function turnstileAllows(verdict: TurnstileVerdict, failOpen: boolean): boolean {
  switch (verdict) {
    case 'ok':
    case 'disabled':
      return true;
    case 'unavailable':
      return failOpen;
    case 'failed':
      return false;
  }
}
