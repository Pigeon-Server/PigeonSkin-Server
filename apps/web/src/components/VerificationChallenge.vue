<script setup lang="ts">
// 多驱动人机验证：按公开设置里的 captcha_driver 加载对应脚本并渲染 widget。
// 对外只暴露 token / randstr 两个 v-model 与 reset()，页面不感知驱动差异。
import { localeTag, normalizeLocale } from '@pigeon-skin/shared/locales';
import { onBeforeUnmount, ref, watch } from 'vue';
import { api } from '@/api';
import { useSiteSettings } from '@/stores/site';
import { useI18n } from '@/stores/i18n';

const token = defineModel<string>({ default: '' });
const randstr = defineModel<string>('randstr', { default: '' });
const i18n = useI18n();
const site = useSiteSettings();

const driver = () => site.get('captcha_driver');
const siteKey = () => site.get('captcha_site_key');
// image 驱动无站点凭据，服务端凭 driver 判定启用，其余驱动看 site key
const active = () => Boolean(driver()) && (driver() === 'image' || Boolean(siteKey()));

const target = ref<HTMLElement | null>(null);
const error = ref(false);
/** image 驱动：服务端返回的题面 SVG */
const svg = ref('');
/** image 驱动：用户输入的答案 */
const imageAnswer = ref('');
/** 阿里云：弹窗确认回调只把 captchaVerifyParam 存起来，真正的校验在表单提交时 */
let aliyunPopup: PopupInstance | null = null;
/** 腾讯：按需 new TencentCaptcha 实例，无持续渲染物 */
let tencentInstance: PopupInstance | null = null;

type ScriptState = 'idle' | 'loading' | 'ready';
const scriptStates = new Map<string, ScriptState>();
const scriptWaiters = new Map<string, Promise<void>>();

/** 各驱动的脚本地址与加载后暴露的全局对象名 */
function scriptFor(d: string): { src: string; global: string; id: string } | null {
  switch (d) {
    case 'turnstile': return { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', global: 'turnstile', id: 'captcha-script-turnstile' };
    case 'recaptcha_v2':
    case 'recaptcha_v3': return { src: `https://www.google.com/recaptcha/api.js?render=explicit&hl=${localeTag(normalizeLocale(i18n.locale.value))}`, global: 'grecaptcha', id: 'captcha-script-recaptcha' };
    case 'tencent': return { src: 'https://turing.captcha.qcloud.com/TCaptcha.js', global: 'TencentCaptcha', id: 'captcha-script-tencent' };
    case 'aliyun': return { src: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js', global: 'initAliyunCaptcha', id: 'captcha-script-aliyun' };
    default: return null;
  }
}
function globalFor(d: string): unknown {
  return (window as unknown as Record<string, unknown>)[scriptFor(d)?.global ?? ''];
}
async function loadScript(d: string): Promise<void> {
  const spec = scriptFor(d);
  if (!spec || globalFor(d)) return;
  if (scriptStates.get(d) === 'ready') return;
  let wait = scriptWaiters.get(d);
  if (!wait) {
    scriptStates.set(d, 'loading');
    // 失败时清掉 waiter 与状态，否则重试永远拿到同一个 rejected promise
    wait = new Promise<void>((resolve, reject) => {
      let script = document.getElementById(spec.id) as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement('script');
        script.id = spec.id;
        script.src = spec.src;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error(d)), { once: true });
    }).then(() => { scriptStates.set(d, 'ready'); })
      .catch((e) => { scriptWaiters.delete(d); scriptStates.delete(d); throw e; });
    scriptWaiters.set(d, wait);
  }
  await wait;
}

function clearTokens() {
  token.value = '';
  randstr.value = '';
}

// ── Cloudflare Turnstile ─────────────────────────────────────────────────────
interface TurnstileApi { render: (el: HTMLElement, o: Record<string, unknown>) => string; reset: (id: string) => void; remove: (id: string) => void }
let turnstileId: string | null = null;

// ── Google reCAPTCHA v2 / v3 ────────────────────────────────────────────────
interface RecaptchaApi {
  render: (el: HTMLElement, o: Record<string, unknown>) => number;
  reset: (id?: number) => void;
  execute: (siteKey: string, o: { action: string }) => Promise<string>;
}
let recaptchaId: number | null = null;

// ── 腾讯云验证码 ─────────────────────────────────────────────────────────────
interface TencentCaptchaResult { ret: number; ticket: string; randstr: string }
interface TencentCaptchaCtor {
  new (appId: string, callback: (r: TencentCaptchaResult) => void, options?: Record<string, unknown>): { show: () => void; destroy?: () => void };
}
/** 腾讯与阿里弹窗实例的公共形状 */
interface PopupInstance { show: () => void; destroy?: () => void }

// ── 阿里云验证码 2.0 ─────────────────────────────────────────────────────────
interface AliyunCaptchaParams {
  SceneId: string;
  mode: string;
  element: string;
  region: string;
  language: string;
  captchaVerifyCallback: (p: string) => Promise<{ captchaResult: boolean; bizResult: boolean }> | { captchaResult: boolean; bizResult: boolean };
  onBizResultCallback: (r: { captchaResult: boolean }) => void;
  getInstance: (i: unknown) => void;
}
interface AliyunCaptchaInit { (params: AliyunCaptchaParams): void }

/** 移除已渲染的内联 widget（turnstile / recaptcha_v2），避免重试时叠加 */
function destroyInlineWidget(d: string) {
  if (d === 'turnstile') {
    const api = globalFor('turnstile') as TurnstileApi | undefined;
    if (api && turnstileId !== null) api.remove(turnstileId);
    turnstileId = null;
  } else if (d === 'recaptcha_v2' && recaptchaId !== null) {
    // grecaptcha 没有 remove(id)，reset 后重新 render 会复用容器
    (globalFor('recaptcha_v2') as RecaptchaApi | undefined)?.reset(recaptchaId);
    recaptchaId = null;
  }
}

async function render() {
  const d = driver();
  if (!d || !target.value) return;
  // image 驱动无 site key：凭据在服务端（SESSION_SECRET），靠 driver 判定启用
  if (d !== 'image' && !siteKey()) return;
  error.value = false;
  try {
    if (d === 'image') {
      await refreshImageCaptcha();
      return;
    }
    await loadScript(d);
    if (!target.value || !globalFor(d)) return;
    destroyInlineWidget(d);
    clearTokens();

    switch (d) {
      case 'turnstile': {
        const api = globalFor(d) as TurnstileApi;
        turnstileId = api.render(target.value, {
          sitekey: siteKey(),
          language: localeTag(normalizeLocale(i18n.locale.value)).toLowerCase(),
          callback: (value: string) => { token.value = value; },
          'expired-callback': () => { token.value = ''; },
          'error-callback': () => { clearTokens(); error.value = true; },
        });
        break;
      }
      case 'recaptcha_v2': {
        const api = globalFor(d) as RecaptchaApi;
        recaptchaId = api.render(target.value, {
          sitekey: siteKey(),
          callback: (value: string) => { token.value = value; },
          'expired-callback': () => { token.value = ''; },
          'error-callback': () => { clearTokens(); error.value = true; },
        });
        break;
      }
      case 'recaptcha_v3': {
        // v3 无可见 widget：直接 execute 拿 token；徽标文案由模板展示
        const api = globalFor(d) as RecaptchaApi;
        try {
          token.value = await api.execute(siteKey(), { action: 'submit' });
        } catch {
          clearTokens();
          error.value = true;
        }
        break;
      }
      case 'tencent': {
        // 弹窗式：渲染触发按钮，点击后 new TencentCaptcha 拉起验证窗
        const Ctor = globalFor(d) as TencentCaptchaCtor;
        tencentInstance = new Ctor(siteKey(), (r) => {
          if (r.ret === 0) {
            token.value = r.ticket;
            randstr.value = r.randstr;
          } else {
            clearTokens();
          }
        });
        break;
      }
      case 'aliyun': {
        const init = globalFor(d) as AliyunCaptchaInit;
        init({
          SceneId: siteKey(),
          mode: 'popup',
          element: '#captcha-aliyun-element',
          region: 'cn',
          language: localeTag(normalizeLocale(i18n.locale.value)),
          captchaVerifyCallback: (param: string) => {
            // 前端先放行以关闭弹窗；真正的服务端校验发生在表单提交时
            token.value = param;
            return { captchaResult: true, bizResult: true };
          },
          onBizResultCallback: () => {},
          getInstance: (instance) => { aliyunPopup = instance as PopupInstance; },
        });
        break;
      }
    }
  } catch {
    error.value = true;
  }
}

/** 腾讯与阿里是弹窗式，点击按钮拉起 */
function openPopup() {
  const d = driver();
  if (d === 'tencent') tencentInstance?.show?.();
  else if (d === 'aliyun') aliyunPopup?.show();
}

/** image 驱动：拉一道新题。签名题串存 token，用户输入存 randstr（校验时成对提交） */
async function refreshImageCaptcha() {
  const challenge = await api.captchaChallenge();
  if (!challenge.challengeId) return;
  svg.value = challenge.svg;
  token.value = challenge.challengeId;
  randstr.value = '';
  imageAnswer.value = '';
}

/** image 驱动：用户输入答案时同步到 randstr */
function onImageAnswerInput() {
  randstr.value = imageAnswer.value;
}

function reset() {
  const d = driver();
  clearTokens();
  if (d === 'image') {
    void refreshImageCaptcha();
    return;
  }
  if (d === 'turnstile') {
    const api = globalFor('turnstile') as TurnstileApi | undefined;
    if (api && turnstileId !== null) api.reset(turnstileId);
  } else if (d === 'recaptcha_v2') {
    (globalFor('recaptcha_v2') as RecaptchaApi | undefined)?.reset(recaptchaId ?? undefined);
  } else if (d === 'recaptcha_v3' || d === 'tencent' || d === 'aliyun') {
    // v3 重新 execute；弹窗式驱动重新拉起
    if (d === 'recaptcha_v3') void render();
    else openPopup();
  }
}

watch([site.settings, target, i18n.locale], () => { void render(); }, { immediate: true, flush: 'post' });
onBeforeUnmount(() => {
  destroyInlineWidget(driver() ?? '');
  aliyunPopup?.destroy?.();
  aliyunPopup = null;
  tencentInstance?.destroy?.();
  tencentInstance = null;
});
defineExpose({ reset });
</script>
<template>
  <div v-if="active()">
    <!-- turnstile / recaptcha_v2：内联渲染区。容器始终存在（v-show），
         保证 render() 里 target ref 可用；其他驱动不需要渲染物。 -->
    <div v-show="driver() === 'turnstile' || driver() === 'recaptcha_v2'" ref="target" />
    <!-- recaptcha_v3：无可见组件，仅披露徽标 -->
    <p v-if="driver() === 'recaptcha_v3'" class="text-xs opacity-70 flex items-center gap-1">
      <span class="material-icons !text-base" aria-hidden="true">verified_user</span>
      {{ i18n.t('auth.captcha_protected') }}
    </p>
    <!-- image：题面 SVG + 答案输入 + 换一题 -->
    <div v-else-if="driver() === 'image'" class="flex items-start gap-2">
      <div v-if="svg" class="shrink-0 rounded border border-line bg-white p-1" v-html="svg" />
      <div class="flex flex-col gap-1 min-w-0">
        <input
          v-model="imageAnswer"
          class="input max-w-40"
          :placeholder="i18n.t('auth.captcha_image_placeholder')"
          :aria-label="i18n.t('auth.captcha_image_placeholder')"
          autocomplete="off"
          @input="onImageAnswerInput"
        >
        <button type="button" class="btn-sm btn self-start" @click="refreshImageCaptcha">
          <span class="material-icons !text-base" aria-hidden="true">refresh</span>
          {{ i18n.t('auth.captcha_image_refresh') }}
        </button>
      </div>
    </div>
    <!-- tencent / aliyun：弹窗式触发按钮 -->
    <button v-else type="button" class="btn-sm btn" @click="openPopup">
      <span class="material-icons !text-base" aria-hidden="true">verified_user</span>
      {{ token ? i18n.t('auth.captcha_verified') : i18n.t('auth.captcha_verify_button') }}
    </button>
    <p v-if="error" class="text-xs text-danger mt-2">
      {{ i18n.t('auth.captcha_failed') }}
      <AppButton class="btn-sm ml-2" @click="render">{{ i18n.t('common.retry') }}</AppButton>
    </p>
  </div>
</template>
