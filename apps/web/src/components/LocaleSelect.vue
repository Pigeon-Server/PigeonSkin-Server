<script setup lang="ts">
import { LOCALE_OPTIONS, isLocale } from '@pigeon-skin/shared/locales';
import { useI18n } from '@/stores/i18n';
import { usePreferences } from '@/composables/preferences';
const i18n = useI18n();
const preferences = usePreferences();
function change(value: string | number | null) {
  if (isLocale(value)) void preferences.setLocale(value);
}
</script>
<template>
  <AppSelect class="!w-auto !min-h-0 !py-1 !text-xs" :model-value="i18n.locale.value" :options="LOCALE_OPTIONS.map(option => ({ value: option.value, label: option.name }))" :aria-label="i18n.t('common.language')" :disabled="preferences.busy.value" @change="change" />
</template>
