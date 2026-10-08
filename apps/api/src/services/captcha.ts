// 人机验证（多驱动）：Turnstile / reCAPTCHA v2 / v3 / 腾讯云验证码 / 阿里云验证码 2.0。
//
// **必须服务端校验**：只在前端检查等于没检查，攻击者直接调 API 就绕过了。
// 这正是旧版 reCAPTCHA 集成做对的一点（Rules/Captcha 会向 Google 发请求验证），
// 这里保留该性质。
//
// 失败策略是**非对称**的，取决于端点的可滥用程度：
//   • 注册、找回密码：失败**关闭** —— 两者都易被滥用，而正常用户几秒后重试即可
//   • 登录升级校验：失败**开放** —— 第三方故障时把全体用户锁在门外，比失去
//     验证码升级更糟

import { sha256Hex, hmacSha256 } from './captcha-internal.ts';
import { verifyImageCaptcha } from './image-captcha.ts';

export type CaptchaVerdict = 'ok' | 'failed' | 'unavailable' | 'disabled';

export type CaptchaDriver = 'turnstile' | 'recaptcha_v2' | 'recaptcha_v3' | 'tencent' | 'aliyun' | 'image';

export interface CaptchaEnv {
  CAPTCHA_DRIVER?: string | undefined;
  CAPTCHA_SITE_KEY?: string | undefined;
  CAPTCHA_SECRET?: string | undefined;
  ALIYUN_CAPTCHA_ACCESS_KEY_ID?: string | undefined;
  RECAPTCHA_V3_THRESHOLD?: string | undefined;
  /** image 驱动：签名题串用 */
  SESSION_SECRET?: string | undefined;
  /** image 驱动：一次性消费标记落 auth_attempts */
  DB?: { prepare: (sql: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown>; first: (row?: string) => Promise<unknown> } } } | undefined;
}

export interface CaptchaAnswer {
  /** 各驱动的前端凭据：Turnstile/reCAPTCHA token、腾讯 ticket、阿里 captchaVerifyParam */
  token: string | undefined;
  /** 仅腾讯云验证码需要：与 ticket 配对的 Randstr */
  randstr?: string | undefined;
}

/** 驱动已配置（凭据齐备）才算启用；半配置一律视为关闭，避免全站校验持续失败 */
export function captchaDriver(env: CaptchaEnv): CaptchaDriver | null {
  const driver = env.CAPTCHA_DRIVER as CaptchaDriver | undefined;
  if (!driver) return null;
  switch (driver) {
    case 'turnstile':
    case 'recaptcha_v2':
    case 'recaptcha_v3':
      return env.CAPTCHA_SECRET ? driver : null;
    case 'tencent':
      return env.CAPTCHA_SITE_KEY && env.CAPTCHA_SECRET ? driver : null;
    case 'aliyun':
      // 阿里：SceneId（site_key）+ AccessKey 对（secret 存 AccessKeySecret）
      return env.CAPTCHA_SITE_KEY && env.CAPTCHA_SECRET && env.ALIYUN_CAPTCHA_ACCESS_KEY_ID ? driver : null;
    case 'image':
      // 自绘图案验证码用 SESSION_SECRET 签题，密钥未配时视为未启用，
      // 否则出题端点 500、fail-closed 端点把用户全锁在门外
      return env.SESSION_SECRET ? driver : null;
    default:
      return null;
  }
}

export function isCaptchaEnabled(env: CaptchaEnv): boolean {
  return captchaDriver(env) !== null;
}

/**
 * 校验一个验证码凭据。返回四值判定，与具体驱动无关。
 *
 * 前端凭据都是短时效且一次性的，不需要自己做防重放。
 */
export async function verifyCaptcha(
  env: CaptchaEnv,
  answer: CaptchaAnswer,
  remoteIp: string,
): Promise<CaptchaVerdict> {
  const driver = captchaDriver(env);
  if (!driver) return 'disabled';
  if (!answer.token) return 'failed';

  try {
    switch (driver) {
      case 'turnstile': return await verifyTurnstile(env, answer.token, remoteIp);
      case 'recaptcha_v2':
      case 'recaptcha_v3': return await verifyRecaptcha(env, driver, answer.token, remoteIp);
      case 'tencent': return await verifyTencent(env, answer.token, answer.randstr, remoteIp);
      case 'aliyun': return await verifyAliyun(env, answer.token);
      case 'image': {
        // 自绘图案验证码：token 存签名题串，randstr 存用户答案；无网络调用
        const ok = await verifyImageCaptcha(env, answer.token, answer.randstr);
        return ok ? 'ok' : 'failed';
      }
    }
  } catch {
    // 网络层失败与"校验不通过"是两回事：前者应该 fail-open，
    // 否则验证码服务商的短暂抖动会让所有人无法注册。
    // 依赖各 provider 对无效 token 都返回 200 + success:false 的约定
    //（Turnstile/reCAPTCHA/腾讯/阿里均如此），HTTP/JSON 层的异常才落到这里。
    return 'unavailable';
  }
}

// ── Cloudflare Turnstile ─────────────────────────────────────────────────────

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstile(env: CaptchaEnv, token: string, remoteIp: string): Promise<CaptchaVerdict> {
  const body = new FormData();
  body.set('secret', env.CAPTCHA_SECRET!);
  body.set('response', token);
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  const response = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body });
  if (!response.ok) return 'unavailable';

  const result = await response.json() as { success?: boolean };
  return result.success === true ? 'ok' : 'failed';
}

// ── Google reCAPTCHA v2 / v3 ─────────────────────────────────────────────────

const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

async function verifyRecaptcha(
  env: CaptchaEnv, driver: 'recaptcha_v2' | 'recaptcha_v3', token: string, remoteIp: string,
): Promise<CaptchaVerdict> {
  const body = new URLSearchParams();
  body.set('secret', env.CAPTCHA_SECRET!);
  body.set('response', token);
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  const response = await fetch(RECAPTCHA_VERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: String(body),
  });
  if (!response.ok) return 'unavailable';

  const result = await response.json() as { success?: boolean; score?: number };
  if (result.success !== true) return 'failed';
  // v3 返回 0~1 的可信度分数，低于阈值视为机器人。
  // 阈值存 0~100 整数（50 = 0.50）；未配置或 env 值非法时回落默认 0.5
  //（NaN 比较恒 false，会让垃圾 env 值静默变成全放行）。
  if (driver === 'recaptcha_v3') {
    const raw = Number.parseInt(env.RECAPTCHA_V3_THRESHOLD ?? '50', 10);
    const threshold = Number.isFinite(raw) ? raw / 100 : 0.5;
    if (typeof result.score !== 'number' || result.score < threshold) return 'failed';
  }
  return 'ok';
}

// ── 腾讯云验证码（天御 Captcha）─────────────────────────────────────────────

const TENCENT_VERIFY_URL = 'https://ssl.captcha.qq.com/ticket/verify';

/**
 * 腾讯的票据校验接口是 GET + 查询串。AppSecret 直接拼进 URL 是腾讯官方约定，
 * 换其他传输方式（如 POST JSON）该接口反而不接受。
 */
async function verifyTencent(
  env: CaptchaEnv, ticket: string, randstr: string | undefined, remoteIp: string,
): Promise<CaptchaVerdict> {
  if (!randstr) return 'failed';
  const query = new URLSearchParams({
    aid: env.CAPTCHA_SITE_KEY!,
    AppSecretKey: env.CAPTCHA_SECRET!,
    Ticket: ticket,
    Randstr: randstr,
  });
  if (remoteIp && remoteIp !== 'unknown') query.set('UserIP', remoteIp);

  const response = await fetch(`${TENCENT_VERIFY_URL}?${query}`);
  if (!response.ok) return 'unavailable';

  const result = await response.json() as { response?: string | number };
  return String(result.response) === '1' ? 'ok' : 'failed';
}

// ── 阿里云验证码 2.0（VerifyIntelligentCaptcha）─────────────────────────────

const ALIYUN_ENDPOINT = 'https://captcha.cn-shanghai.aliyuncs.com/';
const ALIYUN_ACTION = 'VerifyIntelligentCaptcha';
const ALIYUN_VERSION = '2023-03-05';

/**
 * ACS V3 签名（ACS3-HMAC-SHA256）调用阿里云 OpenAPI。
 *
 * RPC 风格参数走 x-www-form-urlencoded body；只签 host 与 x-acs-* 头。
 * Web Crypto 在 Workers 与 Node 上行为一致，不需要 SDK。
 */
async function verifyAliyun(env: CaptchaEnv, captchaVerifyParam: string): Promise<CaptchaVerdict> {
  const body = new URLSearchParams({
    SceneId: env.CAPTCHA_SITE_KEY!,
    CaptchaVerifyParam: captchaVerifyParam,
  });
  const payload = String(body);
  const nonce = crypto.randomUUID();
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // CanonicalHeaders 只含参与签名的头，名称小写、升序
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/x-www-form-urlencoded\nhost:captcha.cn-shanghai.aliyuncs.com\nx-acs-action:${ALIYUN_ACTION}\nx-acs-content-sha256:${await sha256Hex(payload)}\nx-acs-date:${date}\nx-acs-signature-nonce:${nonce}\nx-acs-version:${ALIYUN_VERSION}\n`,
    'content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version',
    await sha256Hex(payload),
  ].join('\n');

  const stringToSign = `ACS3-HMAC-SHA256\n${await sha256Hex(canonicalRequest)}`;
  const signature = await hmacSha256(env.CAPTCHA_SECRET!, stringToSign);

  const response = await fetch(ALIYUN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: 'captcha.cn-shanghai.aliyuncs.com',
      'x-acs-action': ALIYUN_ACTION,
      'x-acs-version': ALIYUN_VERSION,
      'x-acs-date': date,
      'x-acs-signature-nonce': nonce,
      'x-acs-content-sha256': await sha256Hex(payload),
      authorization: `ACS3-HMAC-SHA256 Credential=${env.ALIYUN_CAPTCHA_ACCESS_KEY_ID!},SignedHeaders=content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=${signature}`,
    },
    body: payload,
  });
  if (!response.ok) return 'unavailable';

  const result = await response.json() as {
    Code?: string;
    Result?: { VerifyResult?: boolean };
  };
  // 接口层成功（Code=Success）之下再看业务判定 VerifyResult
  if (result.Code !== 'Success') return 'unavailable';
  return result.Result?.VerifyResult === true ? 'ok' : 'failed';
}

/**
 * 把校验结果转成是否放行。
 * @param failOpen 校验服务不可用时是否放行。注册类端点传 false，登录传 true。
 */
export function captchaAllows(verdict: CaptchaVerdict, failOpen: boolean): boolean {
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
