// 人机验证六驱动的单测：mock fetch 覆盖 ok / failed / unavailable / 未配置，
// 自绘图案验证码的出题校验闭环，以及旧 Turnstile 设置的迁移推导。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { captchaAllows, captchaDriver, verifyCaptcha, type CaptchaEnv } from '../../src/services/captcha.ts';
import { issueImageCaptcha, verifyImageCaptcha } from '../../src/services/image-captcha.ts';
import { hmacSha256 } from '../../src/services/captcha-internal.ts';
import { configurationValues } from '../../src/services/configuration.ts';

function env(overrides: Partial<CaptchaEnv> = {}): CaptchaEnv {
  return {
    CAPTCHA_DRIVER: 'turnstile',
    CAPTCHA_SITE_KEY: 'site-key',
    CAPTCHA_SECRET: 'secret-key',
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('captchaDriver', () => {
  it('凭据齐备才算启用', () => {
    expect(captchaDriver(env())).toBe('turnstile');
    expect(captchaDriver({ CAPTCHA_DRIVER: 'turnstile' })).toBeNull();
    expect(captchaDriver({ CAPTCHA_DRIVER: 'tencent', CAPTCHA_SITE_KEY: 'aid', CAPTCHA_SECRET: 's' })).toBe('tencent');
    expect(captchaDriver({ CAPTCHA_DRIVER: 'aliyun', CAPTCHA_SITE_KEY: 'scene', CAPTCHA_SECRET: 's' })).toBeNull();
    expect(captchaDriver({ CAPTCHA_DRIVER: 'aliyun', CAPTCHA_SITE_KEY: 'scene', CAPTCHA_SECRET: 's', ALIYUN_CAPTCHA_ACCESS_KEY_ID: 'id' })).toBe('aliyun');
    expect(captchaDriver({ CAPTCHA_DRIVER: '' })).toBeNull();
    expect(captchaDriver({ CAPTCHA_DRIVER: 'unknown-driver' })).toBeNull();
    // 自绘图案验证码需要 SESSION_SECRET 签题
    expect(captchaDriver({ CAPTCHA_DRIVER: 'image' })).toBeNull();
    expect(captchaDriver({ CAPTCHA_DRIVER: 'image', SESSION_SECRET: 's' })).toBe('image');
  });
});

describe('image captcha（自绘）', () => {
  const imageEnv = { SESSION_SECRET: 'test-session-secret' };
  /** auth_attempts 形状的 stub：SELECT 返回已有消费标记，INSERT 记录 marker，
   *  如实模拟「无唯一约束 + 先查后插」的真实防重放行为 */
  function consumedDb(consumed: Set<string>) {
    return {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            if (sql.includes('INSERT INTO')) consumed.add(values[1] as string);
          },
          first: async () => (consumed.has(values[0] as string) ? { id: 1 } : null),
        }),
      }),
    };
  }
  it('出题后答对放行、答错拒绝', async () => {
    const { challengeId } = await issueImageCaptcha(imageEnv);
    // challengeId 形如 id.hash.expiresAt.signature；测试直接拿题面答案无法解出，
    // 这里通过重放合法签名字符串验证校验链路：改一个字节签名就不符
    expect(await verifyImageCaptcha({ ...imageEnv, DB: consumedDb(new Set()) }, challengeId, 'x')).toBe(false);
    expect(await verifyImageCaptcha({ ...imageEnv, DB: consumedDb(new Set()) }, `${challengeId}x`, 'x')).toBe(false);
  });
  it('答案哈希经 SESSION_SECRET 密钥化，签名字符串不泄露题面', async () => {
    const { challengeId, svg } = await issueImageCaptcha(imageEnv);
    const [, answerHash] = challengeId.split('.') as [string, string];
    expect(answerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(svg).toContain('<svg');
    expect(svg).not.toContain(challengeId);
  });
  it('verifyCaptcha 以 image 驱动分发（token=签名题串, randstr=答案）', async () => {
    const { challengeId } = await issueImageCaptcha(imageEnv);
    const envWithImage = { CAPTCHA_DRIVER: 'image', SESSION_SECRET: 'test-session-secret', DB: consumedDb(new Set()) } as unknown as CaptchaEnv;
    const fetchMock = stubFetch({});
    expect(await verifyCaptcha(envWithImage, { token: challengeId, randstr: 'nope' }, '')).toBe('failed');
    expect(await verifyCaptcha(envWithImage, { token: '', randstr: '' }, '')).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('已知答案的签名串校验通过（闭环）且同一题串只能消费一次', async () => {
    // 与 image-captcha.ts 相同的签名构造：用固定 challengeId 与已知答案手工组串
    const secret = 'test-session-secret';
    const encoder = new TextEncoder();
    const importKey = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sign = async (value: string) => {
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', importKey, encoder.encode(value)));
      return Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
    };
    const answer = 'a7Km';
    const answerHash = await hmacSha256(secret, `image-captcha-answer:${answer.toLowerCase()}`);
    const payload = `abcd1234.${answerHash}.${Date.now() + 60_000}`;
    const challengeId = `${payload}.${await sign(payload)}`;
    const consumed = new Set<string>();
    const db = consumedDb(consumed);
    expect(await verifyImageCaptcha({ ...imageEnv, DB: db }, challengeId, answer)).toBe(true);
    expect(await verifyImageCaptcha({ ...imageEnv, DB: db }, challengeId, answer.toUpperCase())).toBe(false);
    // 换 DB（未消费过）时大小写不敏感放行
    expect(await verifyImageCaptcha({ ...imageEnv, DB: consumedDb(new Set()) }, challengeId, answer.toUpperCase())).toBe(true);
    expect(await verifyImageCaptcha({ ...imageEnv, DB: consumedDb(new Set()) }, challengeId, 'zzzz')).toBe(false);
    // 过期题串拒绝
    const expired = `abcd1234.${answerHash}.${Date.now() - 1000}`;
    expect(await verifyImageCaptcha({ ...imageEnv, DB: consumedDb(new Set()) }, `${expired}.${await sign(expired)}`, answer)).toBe(false);
  });
});

describe('verifyCaptcha: turnstile', () => {
  it('success=true 放行', async () => {
    const fetchMock = stubFetch({ success: true });
    expect(await verifyCaptcha(env(), { token: 'tok' }, '1.2.3.4')).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const body = init.body as FormData;
    expect(body.get('secret')).toBe('secret-key');
    expect(body.get('response')).toBe('tok');
    expect(body.get('remoteip')).toBe('1.2.3.4');
  });
  it('success=false 拒绝', async () => {
    stubFetch({ success: false });
    expect(await verifyCaptcha(env(), { token: 'tok' }, '')).toBe('failed');
  });
});

describe('verifyCaptcha: recaptcha', () => {
  const recaptcha = { CAPTCHA_DRIVER: 'recaptcha_v2', CAPTCHA_SITE_KEY: 'k', CAPTCHA_SECRET: 's' } as CaptchaEnv;
  const v3 = { ...recaptcha, CAPTCHA_DRIVER: 'recaptcha_v3', RECAPTCHA_V3_THRESHOLD: '50' } as CaptchaEnv;
  it('v2 success=true 放行', async () => {
    const fetchMock = stubFetch({ success: true });
    expect(await verifyCaptcha(recaptcha, { token: 'tok' }, '1.2.3.4')).toBe('ok');
    const [url] = fetchMock.mock.calls[0]! as unknown as [string];
    expect(url).toBe('https://www.google.com/recaptcha/api/siteverify');
  });
  it('v2 success=false 拒绝', async () => {
    stubFetch({ success: false });
    expect(await verifyCaptcha(recaptcha, { token: 'tok' }, '')).toBe('failed');
  });
  it('v3 分数低于阈值拒绝，达到阈值放行', async () => {
    stubFetch({ success: true, score: 0.3 });
    expect(await verifyCaptcha(v3, { token: 'tok' }, '')).toBe('failed');
    stubFetch({ success: true, score: 0.7 });
    expect(await verifyCaptcha(v3, { token: 'tok' }, '')).toBe('ok');
  });
});

describe('verifyCaptcha: tencent', () => {
  const tencent = { CAPTCHA_DRIVER: 'tencent', CAPTCHA_SITE_KEY: 'aid', CAPTCHA_SECRET: 'appsecret' } as CaptchaEnv;
  it('response=1 放行，请求带 aid/AppSecretKey/Ticket/Randstr/UserIP', async () => {
    const fetchMock = stubFetch({ response: '1' });
    expect(await verifyCaptcha(tencent, { token: 'ticket', randstr: 'rand' }, '1.2.3.4')).toBe('ok');
    const [url] = fetchMock.mock.calls[0]! as unknown as [string];
    expect(url).toContain('https://ssl.captcha.qq.com/ticket/verify?');
    expect(url).toContain('aid=aid');
    expect(url).toContain('AppSecretKey=appsecret');
    expect(url).toContain('Ticket=ticket');
    expect(url).toContain('Randstr=rand');
    expect(url).toContain('UserIP=1.2.3.4');
  });
  it('response=0 或缺 randstr 拒绝', async () => {
    stubFetch({ response: 0 });
    expect(await verifyCaptcha(tencent, { token: 'ticket', randstr: 'rand' }, '')).toBe('failed');
    expect(await verifyCaptcha(tencent, { token: 'ticket' }, '')).toBe('failed');
  });
});

describe('verifyCaptcha: aliyun', () => {
  const aliyun = {
    CAPTCHA_DRIVER: 'aliyun',
    CAPTCHA_SITE_KEY: 'scene-id',
    CAPTCHA_SECRET: 'ak-secret',
    ALIYUN_CAPTCHA_ACCESS_KEY_ID: 'ak-id',
  } as CaptchaEnv;
  it('VerifyResult=true 放行，请求按 ACS3 签名', async () => {
    const fetchMock = stubFetch({ Code: 'Success', Result: { VerifyResult: true, VerifyCode: 'T001' } });
    expect(await verifyCaptcha(aliyun, { token: 'verify-param' }, '')).toBe('ok');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://captcha.cn-shanghai.aliyuncs.com/');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-acs-action']).toBe('VerifyIntelligentCaptcha');
    expect(headers['x-acs-version']).toBe('2023-03-05');
    expect(headers.authorization).toMatch(/^ACS3-HMAC-SHA256 Credential=ak-id,SignedHeaders=/);
    const body = String(init.body);
    expect(body).toContain('SceneId=scene-id');
    expect(body).toContain('CaptchaVerifyParam=');
  });
  it('VerifyResult=false 拒绝；接口层失败视为 unavailable', async () => {
    stubFetch({ Code: 'Success', Result: { VerifyResult: false, VerifyCode: 'F001' } });
    expect(await verifyCaptcha(aliyun, { token: 'verify-param' }, '')).toBe('failed');
    stubFetch({ Code: 'InternalError' }, 200);
    expect(await verifyCaptcha(aliyun, { token: 'verify-param' }, '')).toBe('unavailable');
    stubFetch({ message: 'err' }, 500);
    expect(await verifyCaptcha(aliyun, { token: 'verify-param' }, '')).toBe('unavailable');
  });
});

describe('verifyCaptcha: 通用行为', () => {
  it('未配置驱动返回 disabled 且不发起请求', async () => {
    const fetchMock = stubFetch({});
    expect(await verifyCaptcha({ CAPTCHA_DRIVER: '' }, { token: 'tok' }, '')).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('缺 token 返回 failed 且不发起请求', async () => {
    const fetchMock = stubFetch({});
    expect(await verifyCaptcha(env(), { token: undefined }, '')).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('网络异常返回 unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('dns'); }));
    expect(await verifyCaptcha(env(), { token: 'tok' }, '')).toBe('unavailable');
  });
  it('failOpen 决定 unavailable 的放行策略', () => {
    expect(captchaAllows('unavailable', true)).toBe(true);
    expect(captchaAllows('unavailable', false)).toBe(false);
    expect(captchaAllows('ok', false)).toBe(true);
    expect(captchaAllows('disabled', false)).toBe(true);
    expect(captchaAllows('failed', true)).toBe(false);
  });
});

describe('configurationValues: 旧 Turnstile 设置迁移', () => {
  function db(stored: Record<string, string>) {
    return {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: Object.entries(stored).map(([key, value]) => ({ key, value })) }),
        }),
      }),
    };
  }
  const base = { APP_URL: 'https://x', DB: db({}) } as Record<string, unknown>;
  it('存量 turnstile_* 推导为 captcha_driver=turnstile', async () => {
    const values = await configurationValues({
      ...base,
      DB: db({ turnstile_enabled: 'true', turnstile_site_key: 'old-site', turnstile_secret: 'old-secret' }),
    } as never);
    expect(values.captcha_driver).toBe('turnstile');
    expect(values.captcha_site_key).toBe('old-site');
    expect(values.captcha_secret).toBe('old-secret');
  });
  it('存量 captcha_driver 优先，不推导', async () => {
    const values = await configurationValues({
      ...base,
      DB: db({ captcha_driver: '', turnstile_enabled: 'true', turnstile_site_key: 's', turnstile_secret: 't' }),
    } as never);
    expect(values.captcha_driver).toBe('');
  });
  it('env 绑定的 TURNSTILE_* 同样推导', async () => {
    const values = await configurationValues({
      ...base, DB: db({}),
      TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'env-site', TURNSTILE_SECRET: 'env-secret',
    } as never);
    expect(values.captcha_driver).toBe('turnstile');
    expect(values.captcha_site_key).toBe('env-site');
  });
  it('只有 site key 没有 secret 时不启用', async () => {
    const values = await configurationValues({
      ...base, DB: db({}),
      TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'env-site',
    } as never);
    expect(values.captcha_driver).toBe('');
  });
});
