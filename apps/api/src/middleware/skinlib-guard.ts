// 皮肤库反爬守卫：边缘限流 + 渐进式人机验证。
//
// 目标：批量抓取（按 ID 枚举、高频翻页）付出人机验证成本，正常浏览完全无感。
// 覆盖范围由 app.ts 的挂载点决定（列表、详情、描述）；材质 PNG 在外链与游戏
// 加载路径上，明确不设防。
//
// 计数分两档，登录态是更强的信任信号：
//   • 匿名访客：按 IP 走 RL_SKINLIB 紧桶（默认 60 req/min）；
//   • 登录用户：按账号走 RL_SKINLIB_USER 松桶（默认 300 req/min），
//     超限只限速、不挑战 —— 身份已知，挑战没有额外信息量。
//
// 匿名超限时的处置：
//   • 已配置验证码驱动 → 返回 429 skinlib.challenge_required，前端弹验证码；
//   • 未配置驱动 → 普通 429 软限流（fail-open，不弹无法完成的挑战）；
//   • 携带 X-Captcha-Token 且校验通过 → 签发 HMAC 通行证 Cookie（60 分钟），
//     之后的请求以独立计数键放行，不再打扰。
//
// 通行证不解除限流本身：它是"近期通过过人机验证"的证明，持证者仍有
// 60 req/min 的预算，超出只会得到普通 429，不会陷入解不完的挑战循环。
//
// 一切异常路径 fail-open：binding 缺失、校验服务故障、RATE_LIMIT_ENABLED
// 或 SKINLIB_GUARD_ENABLED 关闭，都直接放行。纵深防御不缺一层不该打挂正常访问。

import { getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { flag, type Bindings } from '../env.ts';
import { clientIp, type AppContext, type AppEnv } from '../lib.ts';
import { captchaAllows, captchaDriver, verifyCaptcha } from '../services/captcha.ts';
import { hmacSha256 } from '../services/captcha-internal.ts';

export const SKINLIB_PASS_COOKIE = 'skinlib_pass';
export const SKINLIB_PASS_TTL_SECONDS = 3600;

const PASS_SIGNATURE_CONTEXT = 'skinlib-pass';

type PassEnv = Pick<Bindings, 'SESSION_SECRET'>;

/** 签发通行证：`<expiresAtMs>.<sig>`，sig = HMAC(SESSION_SECRET, 上下文 + 过期时间)。 */
export async function issueSkinlibPass(env: PassEnv, now = Date.now()): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const expiresAt = now + SKINLIB_PASS_TTL_SECONDS * 1000;
  const signature = await hmacSha256(env.SESSION_SECRET, `${PASS_SIGNATURE_CONTEXT}:${expiresAt}`);
  return `${expiresAt}.${signature}`;
}

/** 校验通行证：签名不符或已过期都不通过。无密钥时视为无通行证。 */
export async function verifySkinlibPass(env: PassEnv, value: string | undefined, now = Date.now()): Promise<boolean> {
  if (!env.SESSION_SECRET || !value) return false;
  const parts = value.split('.');
  if (parts.length !== 2) return false;
  const expiresAt = Number(parts[0]);
  if (!Number.isSafeInteger(expiresAt) || now > expiresAt) return false;
  const expected = await hmacSha256(env.SESSION_SECRET, `${PASS_SIGNATURE_CONTEXT}:${expiresAt}`);
  return expected === parts[1];
}

function setSkinlibPassCookie(c: AppContext, value: string): void {
  setCookie(c, SKINLIB_PASS_COOKIE, value, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === 'production',
    sameSite: 'Lax',
    path: '/api/v1/textures',
    maxAge: SKINLIB_PASS_TTL_SECONDS,
  });
}

/**
 * 调用限流 binding。binding 缺失或故障返回 true（放行）—— 与
 * security.ts 的全局限流同语义，限流器故障不能变成全站故障。
 */
async function withinLimit(
  binding: { limit(params: { key: string }): Promise<{ success: boolean }> } | undefined,
  key: string,
): Promise<boolean> {
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true;
  }
}

export function skinlibGuard(): MiddlewareHandler<AppEnv> {
  // 具名以便回归测试从 app.routes 里识别守卫挂载点（见 skinlib-guard.test.ts）
  return async function skinlibGuardHandler(c, next) {
    // 只拦读取。挂载点决定范围（列表、详情、描述；材质 PNG 在外链与游戏
    // 加载路径上，不设防）。HEAD 由 GET 处理器应答，同样计数，否则可以据此
    // 零成本探测材质是否存在。
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') return next();
    if (!flag(c.env.RATE_LIMIT_ENABLED)) return next();
    // 守卫开关默认开启，只有显式关闭才跳过
    if (c.env.SKINLIB_GUARD_ENABLED === 'false' || c.env.SKINLIB_GUARD_ENABLED === '0') return next();

    const ip = clientIp(c);
    const user = c.get('user');

    // 登录用户：按账号计数，阈值宽松；超限是纯限速，不挑战
    if (user) {
      if (await withinLimit(c.env.RL_SKINLIB_USER, `skinlib-user:${user.id}`)) return next();
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'common.rate_limited' }, 429, { 'Retry-After': '60' });
    }

    // 匿名访客：持证与未持证用独立计数键 —— 通过挑战后获得一个新的预算窗口
    const passed = await verifySkinlibPass(c.env, getCookie(c, SKINLIB_PASS_COOKIE));

    // 携带验证码答案的请求先校验再谈限流：解完题即使 60s 窗口恰好滚动
    // 回限额内，也照常签发通行证，不会出现"白解一次"
    if (!passed && captchaDriver(c.env) && c.env.SESSION_SECRET) {
      const token = c.req.header('x-captcha-token');
      if (token) {
        const verdict = await verifyCaptcha(
          c.env,
          { token, randstr: c.req.header('x-captcha-randstr') },
          ip,
        );
        // 读取类端点 fail-open：第三方验证码服务抖动时不把访客锁在门外
        if (captchaAllows(verdict, true)) {
          const pass = await issueSkinlibPass(c.env);
          if (pass) setSkinlibPassCookie(c, pass);
          return next();
        }
      }
    }

    const scope = passed ? 'pass' : 'guest';
    if (await withinLimit(c.env.RL_SKINLIB, `skinlib-${scope}:${ip}`)) return next();

    // 超限：已持证只是太快，不回退到挑战循环；未持证且能挑战时要求人机验证
    if (!passed && captchaDriver(c.env) && c.env.SESSION_SECRET) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'skinlib.challenge_required' }, 429, { 'Retry-After': '60' });
    }

    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'common.rate_limited' }, 429, { 'Retry-After': '60' });
  };
}
