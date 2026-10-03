<script setup lang="ts">
import { localeTag, normalizeLocale } from '@pigeon-skin/shared/locales';
import { onBeforeUnmount, ref, watch } from 'vue';
import { useSiteSettings } from '@/stores/site';
import { useI18n } from '@/stores/i18n';
interface Turnstile {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
const token = defineModel<string>({ default: '' });
const i18n = useI18n();
const site = useSiteSettings();
const target = ref<HTMLElement | null>(null);
const error = ref(false);
let id: string | null = null;
function instance() {
  return (window as unknown as { turnstile?: Turnstile }).turnstile;
}
function loadScript() {
  if (instance()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let script = document.getElementById('turnstile-script') as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement('script');
      script.id = 'turnstile-script';
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('turnstile')), { once: true });
  });
}
async function render() {
  if (!site.get('turnstile_site_key') || !target.value) return;
  error.value = false;
  try {
    await loadScript();
    if (!target.value || !instance()) return;
    if (id) instance()!.remove(id);
    id = instance()!.render(target.value, {
      sitekey: site.get('turnstile_site_key'),
      language: localeTag(normalizeLocale(i18n.locale.value)).toLowerCase(),
      callback: (value: string) => {
        token.value = value;
      },
      'expired-callback': () => {
        token.value = '';
      },
      'error-callback': () => {
        token.value = '';
        error.value = true;
      },
    });
  } catch {
    error.value = true;
  }
}
function reset() {
  token.value = '';
  if (id) instance()?.reset(id);
}
watch([site.settings, target, i18n.locale], render, { immediate: true, flush: 'post' });
onBeforeUnmount(() => {
  if (id) instance()?.remove(id);
});
defineExpose({ reset });
</script>
<template>
  <div v-if="site.get('turnstile_site_key')">
    <div ref="target" />
    <p v-if="error" class="text-xs text-danger mt-2">
      {{ i18n.t('auth.captcha_failed') }}
      <AppButton class="btn-sm ml-2" @click="render">{{ i18n.t('common.retry') }}</AppButton>
    </p>
  </div>
</template>
