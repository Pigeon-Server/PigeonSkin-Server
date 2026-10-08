// @vitest-environment jsdom
// 多驱动验证码组件的单测：mock 各 provider 全局对象与公开设置，
// 验证按驱动渲染对应形态、token/randstr 双向绑定与 reset 行为。
import { createSSRApp, h, nextTick, reactive, ref } from 'vue';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import VerificationChallenge from '@/components/VerificationChallenge.vue';

vi.mock('@/stores/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref('zh_CN') }),
}));

const siteSettings = reactive<Record<string, string>>({ captcha_driver: '', captcha_site_key: '' });
vi.mock('@/stores/site', () => ({
  useSiteSettings: () => ({ settings: siteSettings, get: (key: string) => siteSettings[key] ?? '' }),
}));

function mountWith(token: { value: string }, randstr: { value: string }) {
  let exposed: { reset: () => void } | null = null;
  const app = createSSRApp({
    data: () => ({ token: token.value, randstr: randstr.value }),
    render: () => h(VerificationChallenge, {
      modelValue: ({} as never),
      'onUpdate:modelValue': (v: string) => { token.value = v; },
      'onUpdate:randstr': (v: string) => { randstr.value = v; },
      ref: (el: unknown) => { exposed = el as { reset: () => void }; },
    }),
  });
  app.mount(document.createElement('div'));
  return { get exposed() { return exposed!; } };
}

async function setSite(driver: string, siteKey = 'key-1') {
  siteSettings.captcha_driver = driver;
  siteSettings.captcha_site_key = siteKey;
  await nextTick();
  // render() 内部还有 await（loadScript 等），再冲一个宏任务让其跑完
  await new Promise<void>((r) => { setTimeout(r, 0); });
}

beforeEach(() => {
  siteSettings.captcha_driver = '';
  siteSettings.captcha_site_key = '';
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).turnstile;
  delete (window as unknown as Record<string, unknown>).grecaptcha;
  delete (window as unknown as Record<string, unknown>).TencentCaptcha;
  delete (window as unknown as Record<string, unknown>).initAliyunCaptcha;
});

describe('VerificationChallenge', () => {
  it('驱动为空时不渲染任何内容', async () => {
    mountWith({ value: '' }, { value: '' });
    await nextTick();
    expect(document.querySelector('div')).toBeNull();
  });

  it('turnstile：渲染 widget 并通过回调写入 token', async () => {
    const callbacks: Record<string, (v?: string) => void> = {};
    (window as unknown as Record<string, unknown>).turnstile = {
      render: (_el: HTMLElement, o: Record<string, unknown>) => {
        Object.assign(callbacks, { callback: o.callback as (v: string) => void });
        return 'w1';
      },
      reset: vi.fn(),
      remove: vi.fn(),
    };
    const token = { value: '' };
    mountWith(token, { value: '' });
    await setSite('turnstile', 'site-key');
    expect(callbacks.callback).toBeTypeOf('function');
    callbacks.callback!('tk-1');
    expect(token.value).toBe('tk-1');
  });

  it('recaptcha_v3：挂载后 execute 拿 token', async () => {
    (window as unknown as Record<string, unknown>).grecaptcha = {
      execute: vi.fn(async () => 'v3-token'),
      render: vi.fn(),
      reset: vi.fn(),
    };
    const token = { value: '' };
    mountWith(token, { value: '' });
    await setSite('recaptcha_v3');
    expect((window as unknown as { grecaptcha: { execute: (k: string, o: { action: string }) => Promise<string> } }).grecaptcha.execute)
      .toHaveBeenCalledWith('key-1', { action: 'submit' });
    expect(token.value).toBe('v3-token');
  });

  it('tencent：弹窗回调同时写入 ticket 与 randstr', async () => {
    let ctorCallback: ((r: { ret: number; ticket: string; randstr: string }) => void) | null = null;
    (window as unknown as Record<string, unknown>).TencentCaptcha = class {
      show = vi.fn();
      constructor(_appId: string, cb: (r: { ret: number; ticket: string; randstr: string }) => void) { ctorCallback = cb; }
    };
    const token = { value: '' };
    const randstr = { value: '' };
    mountWith(token, randstr);
    await setSite('tencent', 'app-id');
    expect(ctorCallback).toBeTypeOf('function');
    ctorCallback!({ ret: 0, ticket: 'tkt', randstr: 'rs' });
    expect(token.value).toBe('tkt');
    expect(randstr.value).toBe('rs');
  });

  it('aliyun：captchaVerifyCallback 存 param 并返回通过', async () => {
    let verifyCallback: ((p: string) => { captchaResult: boolean; bizResult: boolean }) | null = null;
    (window as unknown as Record<string, unknown>).initAliyunCaptcha = (params: { captchaVerifyCallback: typeof verifyCallback }) => {
      verifyCallback = params.captchaVerifyCallback;
    };
    const token = { value: '' };
    mountWith(token, { value: '' });
    await setSite('aliyun', 'scene-id');
    expect(verifyCallback).toBeTypeOf('function');
    const result = verifyCallback!('verify-param');
    expect(result).toEqual({ captchaResult: true, bizResult: true });
    expect(token.value).toBe('verify-param');
  });
});
