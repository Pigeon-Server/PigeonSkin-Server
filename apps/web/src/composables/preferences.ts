import { ref } from 'vue';
import type { Locale } from '@pigeon-skin/shared/locales';
import { ApiError, meApi } from '@/api';
import { useI18n, prepareLocale } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { useTheme } from '@/composables/theme';
import { router } from '@/router';
import { DEFAULT_LOCALE } from '@pigeon-skin/shared/locales';
const busy = ref(false);
export function usePreferences() {
  const i18n = useI18n(),
    session = useSessionStore(),
    theme = useTheme();
  async function setLocale(next: Locale) {
    if (busy.value) return;
    const previous = i18n.locale.value;
    busy.value = true;
    try {
      await prepareLocale(next);
      await i18n.setLocale(next);
      await router.replace({ query: { ...router.currentRoute.value.query, lang: next === DEFAULT_LOCALE ? undefined : next } });
      if (!session.user.value || session.user.value.locale === next) return;
      const userId = session.user.value.id;
      await meApi.patchPreferences({ locale: next });
      if (session.user.value?.id === userId) session.user.value.locale = next;
    } catch (e) {
      await i18n.setLocale(previous as Locale);
      await router.replace({ query: { ...router.currentRoute.value.query, lang: previous === DEFAULT_LOCALE ? undefined : previous } });
      session.error.value = e instanceof ApiError ? e.code : 'common.network';
    } finally {
      busy.value = false;
    }
  }
  async function toggleTheme() {
    if (busy.value) return;
    const previous = theme.isDark.value;
    theme.toggle();
    if (!session.user.value) return;
    const userId = session.user.value.id;
    busy.value = true;
    try {
      await meApi.patchPreferences({ isDarkMode: theme.isDark.value });
      if (session.user.value?.id === userId) session.user.value.isDarkMode = theme.isDark.value;
    } catch (e) {
      theme.isDark.value = previous;
      session.error.value = e instanceof ApiError ? e.code : 'common.network';
    } finally {
      busy.value = false;
    }
  }
  return { busy, setLocale, toggleTheme };
}
