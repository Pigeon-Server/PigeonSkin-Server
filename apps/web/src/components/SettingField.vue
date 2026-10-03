<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@/stores/i18n';
import { resolveThemeColor, DEFAULT_THEME_COLOR } from '@/lib/theme';
import DomainListEditor from '@/components/DomainListEditor.vue';
const value = defineModel<string | undefined>({ default: '' });
const props = defineProps<{
  name: string;
  spec: {
    kind: string;
    min?: number | undefined;
    max?: number | undefined;
    values?: readonly string[] | undefined;
    secret?: boolean | undefined;
  };
}>();
const i18n = useI18n();
const id = computed(() => `setting-${props.name}`);
// 设置值在存储与 edits 里统一是字符串；AppNumberField 的模型是 number|null，
// 在 integer 分支做双向转换（空串/非法输入 → null，写回时还原为字符串）
const numberValue = computed<number | null>(() => {
  if (value.value === undefined || value.value === '') return null;
  const parsed = Number(value.value);
  return Number.isFinite(parsed) ? parsed : null;
});
function onNumberInput(next: number | null) {
  value.value = next === null ? '' : String(next);
}
const multiline = computed(
  () =>
    props.spec.kind === 'markdown' ||
    ['custom_css', 'custom_js', 'meta_extras', 'ygg_private_key', 'copyright_text'].includes(
      props.name,
    ),
);
</script>
<template>
  <div
    v-if="['theme_color', 'navbar_color', 'sidebar_color'].includes(name)"
    class="flex flex-wrap items-center gap-2"
  >
    <input
      :id="id"
      type="color"
      :value="resolveThemeColor(value || '') || DEFAULT_THEME_COLOR"
      class="color-input"
      @input="value = ($event.target as HTMLInputElement).value"
    />
    <AppInput
      v-model="value"
      class="max-w-64"
      :aria-label="i18n.t(`admin.setting.${name}`)"
      :placeholder="name === 'theme_color' ? DEFAULT_THEME_COLOR : i18n.t('admin.color_default')"
    />
    <AppButton v-if="name !== 'theme_color'" class="btn-sm" @click="value = ''">
      {{ i18n.t('admin.color_default') }}
    </AppButton>
  </div>
  <div v-else-if="spec.secret" class="flex items-center gap-2">
    <AppInput :id="id" :model-value="value === '********' ? '' : value" @update:model-value="value = $event" :placeholder="value === '********' ? i18n.t('integration.configured') : ''" type="password" autocomplete="new-password" :maxlength="spec.max" :aria-label="i18n.t(`admin.setting.${name}`)" />
    <AppButton class="btn-sm" @click="value = ''">{{ i18n.t('admin.clear_credential') }}</AppButton>
  </div>
  <DomainListEditor v-else-if="name.startsWith('restricted_email_')" :id="id" v-model="value" />
  <AppSelect v-else-if="spec.kind === 'boolean'" :id="id" v-model="value" class="max-w-48" :options="[{ value: 'true', label: i18n.t('common.enabled') }, { value: 'false', label: i18n.t('common.disabled') }]" />
  <AppSelect v-else-if="spec.kind === 'enum'" :id="id" v-model="value" class="max-w-64" :options="(spec.values || []).map(option => ({ value: option, label: i18n.t(`admin.option.${option}`) }))" />
  <AppSelect v-else-if="name === 'copyright_preset'" :id="id" v-model="value" :options="Array.from({ length: 7 }, (_, preset) => ({ value: String(preset), label: i18n.t(`common.copyright_presets.${preset}`, { product: i18n.t('common.product_name'), love: i18n.t('common.care') }) }))" />
  <AppNumberField v-else-if="spec.kind === 'integer'" :id="id" :model-value="numberValue" @update:model-value="onNumberInput" :min="spec.min" :max="spec.max" class="max-w-64" />
  <AppInput
    v-else-if="multiline"
    :id="id"
    v-model="value"
    multiline
    class="min-h-32"
    :class="['custom_css', 'custom_js', 'ygg_private_key'].includes(name) ? 'font-mono text-xs' : ''"
    :maxlength="spec.max"
  />
  <AppInput v-else :id="id" v-model="value" :maxlength="spec.max" :placeholder="name === 'icp_beian' ? i18n.t('admin.icp_beian_placeholder') : name === 'public_security_beian' ? i18n.t('admin.public_security_beian_placeholder') : undefined" />
</template>
