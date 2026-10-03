// 站点公开设置：应用启动时拉一次（settingsApi.public），缓存为响应式单例。
// 全局注入（adsense/gtag/custom_css/meta）与各页面按需读取（如 comments_enabled）
// 都走这里，避免每个页面重复请求。
import { ref } from 'vue';
import { settingsApi, ApiError } from '@/api';
import { i18nPlugin } from '@/stores/i18n';
import { decodeLegacyContent } from '@/lib/content';

const settings = ref<Record<string, string>>({});
const fetched = ref(false);
const loading = ref(false);
const error = ref('');
let inflight: Promise<void> | null = null;
let requestedLocale = '';

export function useSiteSettings() {
  async function fetch(force = false): Promise<void> {
    if (fetched.value && !force) return;
    if (!inflight) {
      requestedLocale = i18nPlugin.global.locale.value;
      const locale = requestedLocale;
      loading.value = true;
      error.value = '';
      inflight = settingsApi
        .public(locale)
        .then((s) => {
          if (locale !== i18nPlugin.global.locale.value) return;
          for (const key of [
            'announcement',
            'copyright_text',
            'content_policy',
            'site_description',
            'config_generator_intro',
          ]) {
            if (s[key]) s[key] = decodeLegacyContent(s[key]!);
          }
          settings.value = s;
          fetched.value = true;
        })
        .catch((e) => {
          error.value = e instanceof ApiError ? e.code : 'common.network';
        })
        .finally(() => {
          inflight = null;
          loading.value = false;
        });
    }
    await inflight;
    if (requestedLocale !== i18nPlugin.global.locale.value) await fetch(true);
  }

  function get(key: string): string {
    const value = settings.value[key] ?? '';
    return ['announcement', 'copyright_text', 'content_policy', 'site_description', 'config_generator_intro'].includes(key)
      ? decodeLegacyContent(value)
      : value;
  }

  return { settings, ready: fetched, loading, error, fetch, get };
}
