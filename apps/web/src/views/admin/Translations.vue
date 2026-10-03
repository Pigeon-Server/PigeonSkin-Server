<script setup lang="ts">
import { LOCALE_OPTIONS, type Locale } from '@pigeon-skin/shared/locales';
import { computed, onMounted, ref, watch } from 'vue';
import { adminApi } from '@/api';
import { baseMessages, reloadTranslations, prepareLocale, useI18n } from '@/stores/i18n';
import { confirmAction } from '@/stores/dialog';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const locale = ref<Locale>('zh_CN');
watch(locale, value => { void prepareLocale(value); });
const search = ref('');
const items = ref<Array<{ locale: Locale; key: string; value: string }>>([]);
const selected = ref('');
const edit = ref('');
const open = ref(false);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');
function flatten(
  data: Record<string, unknown>,
  prefix = '',
): Array<{ key: string; value: string }> {
  return Object.entries(data).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [{ key: prefix + key, value }]
      : flatten(value as Record<string, unknown>, prefix + key + '.'),
  );
}
const source = computed(() => flatten(baseMessages[locale.value] || {}));
const visible = computed(() =>
  source.value.filter(
    (row) =>
      row.key.toLowerCase().includes(search.value.toLowerCase()) ||
      row.value.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const override = (key: string) =>
  items.value.find((row) => row.key === key && row.locale === locale.value);
async function load() {
  loading.value = true;
  error.value = '';
  try {
    items.value = (await adminApi.translations()).items;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
function pick(key: string, value: string) {
  selected.value = key;
  edit.value = override(key)?.value || value;
  open.value = true;
}
async function save() {
  busy.value = true;
  error.value = '';
  try {
    await adminApi.putTranslation({ locale: locale.value, key: selected.value, value: edit.value });
    await load();
    await reloadTranslations();
    open.value = false;
    notice.value = i18n.t('general.op-success');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function reset(key: string) {
  if (!(await confirmAction(i18n.t('admin.translation_reset')))) return;
  busy.value = true;
  try {
    await adminApi.deleteTranslation(locale.value, key);
    await load();
    await reloadTranslations();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('admin.translations')" />
  <div class="filter-bar">
    <AppSelect v-model="locale" class="!w-auto" :options="LOCALE_OPTIONS.map(option => ({ value: option.value, label: option.name }))" :aria-label="i18n.t('common.language')" />
    <AppInput
      v-model="search"
      class="max-w-md"
      :aria-label="i18n.t('general.search')"
      :placeholder="i18n.t('general.search')"
    />
  </div>
  <p v-if="error" class="alert alert-danger" role="alert">
    {{ error }}
    <AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton>
  </p>
  <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
  <AppSkeleton v-if="loading" :count="3" />
  <div v-else class="panel !p-0 overflow-x-auto max-h-[70vh]">
    <table class="table">
      <thead class="sticky top-0">
        <tr>
          <th>{{ i18n.t('admin.translation_key') }}</th>
          <th>{{ i18n.t('admin.translation_base') }}</th>
          <th>{{ i18n.t('admin.translation_value') }}</th>
          <th>{{ i18n.t('common.actions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visible" :key="row.key">
          <td class="font-mono text-xs">{{ row.key }}</td>
          <td class="min-w-48 max-w-sm whitespace-pre-wrap">{{ row.value }}</td>
          <td class="min-w-48 max-w-sm whitespace-pre-wrap">
            {{ override(row.key)?.value || i18n.t('common.none') }}
          </td>
          <td>
            <div class="flex gap-2">
              <AppButton class="btn-sm" @click="pick(row.key, row.value)">
                {{ i18n.t('common.edit') }}
              </AppButton>
              <AppButton
                v-if="override(row.key)"
                class="btn-sm"
                :disabled="busy"
                @click="reset(row.key)"
              >
                {{ i18n.t('admin.translation_reset') }}
              </AppButton>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <AppDialog v-model="open" :title="i18n.t('common.edit')" :busy="busy">
    <AppForm class="space-y-4" @submit.prevent="save">
      <p class="font-mono text-xs text-muted">{{ selected }}</p>
      <label for="translation-value">{{ i18n.t('admin.translation_value') }}</label>
      <AppInput id="translation-value" v-model="edit" multiline class="min-h-40" required />
      <p v-if="error" class="alert alert-danger">{{ error }}</p>
      <AppButton type="submit" class="btn-primary" :loading="busy">
        {{ i18n.t('common.save') }}
      </AppButton>
    </AppForm>
  </AppDialog>
</template>
