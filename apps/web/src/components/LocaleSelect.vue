<script setup lang="ts">
import { computed } from 'vue';
import { LOCALE_OPTIONS, isLocale } from '@pigeon-skin/shared/locales';
import { useI18n } from '@/stores/i18n';
import { usePreferences } from '@/composables/preferences';
const i18n = useI18n();
const preferences = usePreferences();
const currentLocaleName = computed(() => LOCALE_OPTIONS.find(option => option.value === i18n.locale.value)?.name ?? '');
const ariaLabel = computed(() => `${i18n.t('common.language')}: ${currentLocaleName.value}`);
function change(value: string | number | null) {
  if (isLocale(value)) void preferences.setLocale(value);
}
</script>
<template>
  <AppSelect class="btn-icon" :model-value="i18n.locale.value" :options="LOCALE_OPTIONS.map(option => ({ value: option.value, label: option.name }))" :aria-label="ariaLabel" :disabled="preferences.busy.value" @change="change">
    <template #activator><AppIcon name="translate" /></template>
  </AppSelect>
</template>
