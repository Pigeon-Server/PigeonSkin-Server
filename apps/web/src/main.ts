import { createApp } from 'vue';
import { watch } from 'vue';
import { createPopoverPlugin } from '@vuetify/v0/popover';
import { FloatingUIPopoverAdapter } from '@vuetify/v0/popover/adapters/floating-ui';
import App from '@/App.vue';
import { router } from '@/router';
import { i18nPlugin, prepareLocale, setLocale } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { useTheme } from '@/composables/theme';
import { normalizeLocale } from '@pigeon-skin/shared/locales';
import { startGlobalInjection } from '@/lib/inject';
import AppButton from '@/components/ui/AppButton.vue';
import AppDialog from '@/components/ui/AppDialog.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import PageHeader from '@/components/ui/PageHeader.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import AppPagination from '@/components/ui/AppPagination.vue';
import MarkdownContent from '@/components/ui/MarkdownContent.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppCombobox from '@/components/ui/AppCombobox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppNumberField from '@/components/ui/AppNumberField.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppRadioGroup from '@/components/ui/AppRadioGroup.vue';
import AppSwitch from '@/components/ui/AppSwitch.vue';
import AppCheckboxGroup from '@/components/ui/AppCheckboxGroup.vue';
import AppAlert from '@/components/ui/AppAlert.vue';
import AppForm from '@/components/ui/AppForm.vue';
import 'material-design-icons-iconfont/dist/material-design-icons.css';
import '@/fonts/minecraft.css';
import '@/styles.css';
const app = createApp(App);
app.use(i18nPlugin).use(router);
app.use(createPopoverPlugin({ adapter: new FloatingUIPopoverAdapter() }));
for (const [name, component] of Object.entries({
  AppButton,
  AppDialog,
  AppIcon,
  PageHeader,
  EmptyState,
  AppSkeleton,
  AppPagination,
  MarkdownContent,
  AppSelect,
  AppCombobox,
  AppInput,
  AppNumberField,
  AppCheckbox,
  AppRadioGroup,
  AppSwitch,
  AppCheckboxGroup,
  AppAlert,
  AppForm,
}))
  app.component(name, component);
startGlobalInjection();
void prepareLocale(normalizeLocale(i18nPlugin.global.locale.value)).catch(() => {}).then(() => app.mount('#app'));
watch(() => router.currentRoute.value.query.lang, async value => {
  if (typeof value !== 'string') return;
  const locale = normalizeLocale(value);
  if (i18nPlugin.global.locale.value === locale) return;
  try {
    await prepareLocale(locale);
    if (typeof router.currentRoute.value.query.lang === 'string' && normalizeLocale(router.currentRoute.value.query.lang) === locale) await setLocale(locale);
  } catch { return; }
});
const session = useSessionStore();
watch(
  () => session.user.value?.id,
  () => {
    const user = session.user.value;
    if (!user) return;
    if (user.locale && !new URLSearchParams(location.search).has('lang')) void setLocale(normalizeLocale(user.locale));
    useTheme().isDark.value = user.isDarkMode;
  },
);
void session.fetchSession();
