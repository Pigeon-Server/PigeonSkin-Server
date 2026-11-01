// @vitest-environment jsdom
// 登录页契约：
// 1) 人机验证"失败升级"：验证组件默认不渲染，后端下发失败升级信号（403
//    auth.captcha_failed 或 401 captchaRequired）后才出现；切换账号时收起。
// 2) 通行密钥主流程（Apple ID 式）：支持 passkey 且未回落时，提交先走
//    passkey（options 带 identifier）；成功直接 applyGrant 跳转；浏览器侧
//    无匹配/取消静默回落密码；回落后再提交直接走密码。
//
// 不 mock @/api 的其余导出：session.login 用真实 ApiError 类抛错，
// 保证 Login 里的 instanceof 判定与生产同源（importOriginal 保留）。
// mock 一律经"委托函数"转发到 spy 变量：组件捕获的是委托闭包，
// beforeEach 里重绑 spy 后调用记录仍可达。
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import Login from '@/views/auth/Login.vue';
import { ApiError } from '@/api';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppForm from '@/components/ui/AppForm.vue';
import AppRadioGroup from '@/components/ui/AppRadioGroup.vue';

type Grant = { accessToken: string; refreshToken: string; expiresIn: number; user: unknown; redirect: string };
type LoginInput = Record<string, unknown>;

let loginSpy: ReturnType<typeof vi.fn>;
let applyGrantSpy: ReturnType<typeof vi.fn>;
let pushSpy: ReturnType<typeof vi.fn>;
let passkeysSupportedSpy: ReturnType<typeof vi.fn>;
let startAuthenticationSpy: ReturnType<typeof vi.fn>;
let loginOptionsSpy: ReturnType<typeof vi.fn>;
let passkeyVerifySpy: ReturnType<typeof vi.fn>;
let cancelCeremonySpy: ReturnType<typeof vi.fn>;

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: (to: string) => pushSpy(to) }),
  useRoute: () => ({ query: {} }),
}));
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({
    loaded: false,
    user: null,
    applyGrant: (grant: unknown) => applyGrantSpy(grant),
    login: (input: LoginInput) => loginSpy(input),
  }),
}));
vi.mock('@/stores/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'zh_CN' }) }));
vi.mock('@/stores/site', () => ({
  useSiteSettings: () => ({
    fetch: () => Promise.resolve(),
    get: (key: string) => ({ captcha_driver: 'turnstile', captcha_site_key: 'key-1' } as Record<string, string>)[key] ?? '',
  }),
}));
vi.mock('@/lib/security', () => ({
  passkeysSupported: () => passkeysSupportedSpy(),
  // 测试里直接透传仪式 Promise，不真跑 120s 看门狗
  runCeremony: (action: () => Promise<unknown>) => action(),
  cancelPasskeyCeremony: () => cancelCeremonySpy(),
}));
vi.mock('@/lib/api-error', () => ({ apiErrorMessage: (e: unknown) => (e instanceof ApiError ? e.code : 'common.network') }));
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: (args: { optionsJSON: unknown }) => startAuthenticationSpy(args) }));
vi.mock('@/api', async importOriginal => {
  const original = await importOriginal<typeof import('@/api')>();
  return {
    ...original,
    securityApi: {
      loginOptions: (remember: boolean, destination: string, identifier?: string) => loginOptionsSpy(remember, destination, identifier),
      passkeyLogin: (response: unknown) => passkeyVerifySpy(response),
    },
  };
});
vi.mock('@/components/auth/OAuthButtons.vue', () => ({ default: { template: '<div class="oauth-stub" />' } }));
vi.mock('@/components/VerificationChallenge.vue', () => ({ default: { template: '<div class="challenge-stub" />' } }));

function createWrapper() {
  return mount(Login, {
    global: {
      components: {
        AppButton,
        AppInput,
        AppCheckbox,
        AppForm,
        AppRadioGroup,
        'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' },
      },
    },
  });
}
async function flush() {
  await new Promise<void>(r => setTimeout(r, 0));
  await new Promise<void>(r => setTimeout(r, 0));
}
async function fillIdentifierAndSubmit(wrapper: ReturnType<typeof mount>) {
  await wrapper.find('#identifier').setValue('someone@example.com');
  await wrapper.find('form').trigger('submit');
  await flush();
}
function passwordAreaHidden(wrapper: ReturnType<typeof mount>) {
  // 密码区（含 label 的包裹 div）承载 v-show
  return wrapper.find('label[for="password"]').element.parentElement!.style.display === 'none';
}

beforeEach(() => {
  loginSpy = vi.fn(async () => ({}));
  applyGrantSpy = vi.fn();
  pushSpy = vi.fn(async () => {});
  passkeysSupportedSpy = vi.fn(() => false);
  loginOptionsSpy = vi.fn(async () => ({}));
  passkeyVerifySpy = vi.fn(async () => { throw new Error('unused'); });
  startAuthenticationSpy = vi.fn(async () => { throw new Error('unused'); });
  cancelCeremonySpy = vi.fn();
});

describe('Login 失败升级人机验证', () => {
  it('默认不渲染验证组件', () => {
    const wrapper = createWrapper();
    expect(wrapper.find('.challenge-stub').exists()).toBe(false);
  });

  it('403 auth.captcha_failed（达阈值无凭据）后渲染验证组件', async () => {
    const wrapper = createWrapper();
    loginSpy.mockRejectedValue(new ApiError(403, { error: 'auth.captcha_failed' }));
    await fillIdentifierAndSubmit(wrapper);
    expect(wrapper.find('.challenge-stub').exists()).toBe(true);
  });

  it('401 携带 captchaRequired 信号后同样渲染验证组件', async () => {
    const wrapper = createWrapper();
    loginSpy.mockRejectedValue(new ApiError(401, { error: 'auth.invalid_credentials', captchaRequired: true }));
    await fillIdentifierAndSubmit(wrapper);
    expect(wrapper.find('.challenge-stub').exists()).toBe(true);
  });

  it('普通密码错误（无升级信号）不渲染验证组件', async () => {
    const wrapper = createWrapper();
    loginSpy.mockRejectedValue(new ApiError(401, { error: 'auth.invalid_credentials' }));
    await fillIdentifierAndSubmit(wrapper);
    expect(wrapper.find('.challenge-stub').exists()).toBe(false);
  });

  it('切换账号后收起升级提示（后端按 identifier 计数）', async () => {
    const wrapper = createWrapper();
    loginSpy.mockRejectedValue(new ApiError(403, { error: 'auth.captcha_failed' }));
    await fillIdentifierAndSubmit(wrapper);
    expect(wrapper.find('.challenge-stub').exists()).toBe(true);
    await wrapper.find('#identifier').setValue('other@example.com');
    expect(wrapper.find('.challenge-stub').exists()).toBe(false);
  });
});

describe('Login 通行密钥主流程', () => {
  it('不支持 passkey 时直接密码登录（主按钮为登录，密码区可见）', async () => {
    const wrapper = createWrapper();
    await wrapper.find('#identifier').setValue('someone@example.com');
    await wrapper.find('#password').setValue('correct-horse');
    await wrapper.find('form').trigger('submit');
    await flush();
    expect(passwordAreaHidden(wrapper)).toBe(false);
    expect(wrapper.find('button[type="submit"]').text()).toBe('auth.login');
    expect(loginSpy).toHaveBeenCalledWith(expect.objectContaining({ identifier: 'someone@example.com', password: 'correct-horse' }));
    expect(startAuthenticationSpy).not.toHaveBeenCalled();
  });

  it('支持 passkey 且未输密码：options 带 identifier，成功后 applyGrant 并跳转，不走密码', async () => {
    passkeysSupportedSpy.mockReturnValue(true);
    const wrapper = createWrapper();
    const grant: Grant = { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, user: { id: 1 }, redirect: '/user' };
    passkeyVerifySpy.mockResolvedValue(grant);
    startAuthenticationSpy.mockImplementation(async ({ optionsJSON }: { optionsJSON: unknown }) => ({ optionsJSON, response: 'proof' }));
    await fillIdentifierAndSubmit(wrapper);
    expect(loginOptionsSpy).toHaveBeenCalledWith(false, '/user', 'someone@example.com');
    expect(passkeyVerifySpy).toHaveBeenCalledTimes(1);
    expect(applyGrantSpy).toHaveBeenCalledWith(grant);
    expect(pushSpy).toHaveBeenCalledWith('/user');
    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('浏览器无匹配凭据（NotFoundError）：静默回落密码，按钮变登录，再提交走密码', async () => {
    passkeysSupportedSpy.mockReturnValue(true);
    const wrapper = createWrapper();
    startAuthenticationSpy.mockRejectedValueOnce(new DOMException('No credential found', 'NotFoundError'));
    await fillIdentifierAndSubmit(wrapper);
    expect(wrapper.find('.alert-danger').exists()).toBe(false);
    expect(loginSpy).not.toHaveBeenCalled();
    expect(wrapper.find('button[type="submit"]').text()).toBe('auth.login');
    expect(passwordAreaHidden(wrapper)).toBe(false);
    // 回落后再提交：不再尝试 passkey，直接密码登录
    await wrapper.find('#password').setValue('correct-horse');
    await wrapper.find('form').trigger('submit');
    await flush();
    expect(startAuthenticationSpy).toHaveBeenCalledTimes(1);
    expect(loginSpy).toHaveBeenCalledWith(expect.objectContaining({ password: 'correct-horse' }));
  });

  it('用户取消（NotAllowedError）同样静默回落且不报错', async () => {
    passkeysSupportedSpy.mockReturnValue(true);
    const wrapper = createWrapper();
    startAuthenticationSpy.mockRejectedValueOnce(new DOMException('Canceled', 'NotAllowedError'));
    await fillIdentifierAndSubmit(wrapper);
    expect(wrapper.find('.alert-danger').exists()).toBe(false);
    expect(passwordAreaHidden(wrapper)).toBe(false);
    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('simplewebauthn 包装的取消（WebAuthnError，普通 Error 非 DOMException）同样静默回落', async () => {
    passkeysSupportedSpy.mockReturnValue(true);
    const wrapper = createWrapper();
    const wrapped = new Error('Authentication ceremony was sent an abort signal');
    wrapped.name = 'AbortError';
    startAuthenticationSpy.mockRejectedValueOnce(wrapped);
    await fillIdentifierAndSubmit(wrapper);
    expect(wrapper.find('.alert-danger').exists()).toBe(false);
    expect(passwordAreaHidden(wrapper)).toBe(false);
    expect(wrapper.find('button[type="submit"]').text()).toBe('auth.login');
    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('仪式挂起期间改账号：旧仪式结束后新账号不被标记已尝试', async () => {
    passkeysSupportedSpy.mockReturnValue(true);
    const wrapper = createWrapper();
    let ceremonyReject!: (error: Error) => void;
    startAuthenticationSpy.mockImplementationOnce(
      () => new Promise((_, reject) => { ceremonyReject = reject; }),
    );
    await wrapper.find('#identifier').setValue('someone@example.com');
    await wrapper.find('form').trigger('submit');
    await flush();
    // 仪式挂起期间换账号：watch 重置回落状态（主按钮仍在 loading，文案含 spinner 文本）
    await wrapper.find('#identifier').setValue('other@example.com');
    expect(wrapper.find('button[type="submit"]').text()).toContain('common.continue');
    // 旧账号的仪式落地（回落）：不应覆盖新账号的重置状态
    ceremonyReject(new DOMException('No credential found', 'NotFoundError'));
    await flush();
    expect(wrapper.find('button[type="submit"]').text()).toBe('common.continue');
    expect(passwordAreaHidden(wrapper)).toBe(true);
    // 新账号提交仍走 passkey
    await wrapper.find('form').trigger('submit');
    await flush();
    expect(loginOptionsSpy).toHaveBeenCalledWith(false, '/user', 'other@example.com');
    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('仪式进行中显示取消按钮，点击中止仪式并回落', async () => {
    passkeysSupportedSpy.mockReturnValue(true);
    const wrapper = createWrapper();
    let ceremonyReject!: (error: Error) => void;
    startAuthenticationSpy.mockImplementationOnce(
      () => new Promise((_, reject) => { ceremonyReject = reject; }),
    );
    await wrapper.find('#identifier').setValue('someone@example.com');
    await wrapper.find('form').trigger('submit');
    await flush();
    // 仪式挂起：取消按钮出现，主按钮仍是"继续"
    const cancelButton = wrapper.findAll('button').find(b => b.text() === 'common.cancel');
    expect(cancelButton).toBeTruthy();
    await cancelButton!.trigger('click');
    expect(cancelCeremonySpy).toHaveBeenCalledTimes(1);
    // 平台弹框收到中止后以 AbortError 落地：静默回落
    ceremonyReject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(wrapper.find('.alert-danger').exists()).toBe(false);
    expect(wrapper.findAll('button').find(b => b.text() === 'common.cancel')).toBeUndefined();
    expect(wrapper.find('button[type="submit"]').text()).toBe('auth.login');
  });

  it('服务端 ApiError 正常提示并回落密码', async () => {
    passkeysSupportedSpy.mockReturnValue(true);
    const wrapper = createWrapper();
    loginOptionsSpy.mockRejectedValue(new ApiError(403, { error: 'security.https_required' }));
    await fillIdentifierAndSubmit(wrapper);
    expect(wrapper.find('.alert-danger').text()).toBe('security.https_required');
    expect(loginSpy).not.toHaveBeenCalled();
    expect(passwordAreaHidden(wrapper)).toBe(false);
  });

  it('已输入密码时跳过 passkey 直接登录', async () => {
    passkeysSupportedSpy.mockReturnValue(true);
    const wrapper = createWrapper();
    await wrapper.find('#identifier').setValue('someone@example.com');
    await wrapper.find('#password').setValue('correct-horse');
    await wrapper.find('form').trigger('submit');
    await flush();
    expect(startAuthenticationSpy).not.toHaveBeenCalled();
    expect(loginSpy).toHaveBeenCalledWith(expect.objectContaining({ password: 'correct-horse' }));
  });

  it('切换账号后重置回落状态（新账号可再次尝试 passkey）', async () => {
    passkeysSupportedSpy.mockReturnValue(true);
    const wrapper = createWrapper();
    startAuthenticationSpy.mockRejectedValueOnce(new DOMException('No credential found', 'NotFoundError'));
    await fillIdentifierAndSubmit(wrapper);
    expect(wrapper.find('button[type="submit"]').text()).toBe('auth.login');
    await wrapper.find('#identifier').setValue('other@example.com');
    expect(wrapper.find('button[type="submit"]').text()).toBe('common.continue');
    await wrapper.find('form').trigger('submit');
    await flush();
    expect(loginOptionsSpy).toHaveBeenCalledWith(false, '/user', 'other@example.com');
    expect(loginSpy).not.toHaveBeenCalled();
  });
});
