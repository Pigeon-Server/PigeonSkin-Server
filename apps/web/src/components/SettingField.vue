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
  /** AI 覆盖项为空时展示的内置默认值（placeholder），由 Settings.vue 从 aiDefaults 传入 */
  aiDefault?: string | undefined;
  /** AI 模型字段的可选列表（管理员点"获取列表"后填充） */
  modelOptions?: string[] | undefined;
  /** 拉取模型列表中的状态 */
  modelsLoading?: boolean | undefined;
  /** 当前生效驱动：workers 下无模型列表 API，隐藏获取/测试按钮 */
  effectiveDriver?: 'workers' | 'openai' | 'anthropic' | '' | undefined;
  /** 连通性测试结果文案 */
  testResult?: string | undefined;
  testLoading?: boolean | undefined;
}>();
const emit = defineEmits<{ 'fetch-models': []; 'test-connection': [] }>();
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
function enumOptionLabel(option: string): string {
  if (option === '') {
    if (props.name === 'captcha_driver') {
      return i18n.te('admin.option.captcha_driver_none')
        ? i18n.t('admin.option.captcha_driver_none')
        : i18n.t('common.disabled');
    }
    const defaultKey = `admin.option.${props.name}_default`;
    if (i18n.te(defaultKey)) return i18n.t(defaultKey);
    return i18n.t('admin.option_default');
  }
  const fieldKey = `admin.option.${props.name}_${option}`;
  if (i18n.te(fieldKey)) return i18n.t(fieldKey);
  return i18n.t(`admin.option.${option}`);
}
const multiline = computed(
  () =>
    props.spec.kind === 'markdown' ||
    props.name.startsWith('ai_') && props.name.endsWith('_prompt') ||
    ['custom_css', 'custom_js', 'meta_extras', 'ygg_private_key', 'copyright_text'].includes(
      props.name,
    ),
);
const isAiModelField = computed(() => props.name.startsWith('ai_') && props.name.endsWith('_model'));
// 拉到列表走下拉选择，未拉取（含 Workers 驱动）时退回纯文本框
const hasModelOptions = computed(() => isAiModelField.value && (props.modelOptions?.length ?? 0) > 0);
// Workers AI 没有模型列表 API，隐藏获取按钮；测试按钮保留（workers 可连通性测试）
const showFetchModels = computed(() => isAiModelField.value && props.effectiveDriver !== 'workers');
const showTest = computed(() => isAiModelField.value);
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
  <AppSelect v-else-if="spec.kind === 'enum'" :id="id" v-model="value" class="max-w-64" :options="(spec.values || []).map(option => ({ value: option, label: enumOptionLabel(option) }))" />
  <AppSelect v-else-if="name === 'copyright_preset'" :id="id" v-model="value" :options="Array.from({ length: 7 }, (_, preset) => ({ value: String(preset), label: i18n.t(`common.copyright_presets.${preset}`, { product: i18n.t('common.product_name'), love: i18n.t('common.care') }) }))" />
  <AppNumberField v-else-if="spec.kind === 'integer'" :id="id" :model-value="numberValue" @update:model-value="onNumberInput" :min="spec.min" :max="spec.max" class="max-w-64" />
  <!-- AI 模型字段：可下拉选择、可过滤、可直接手输列表外的模型名 -->
  <div v-else-if="isAiModelField" class="flex flex-col gap-1">
    <div class="flex flex-wrap items-center gap-2">
      <AppCombobox
        v-if="hasModelOptions"
        v-model="value"
        :id="id"
        :options="modelOptions || []"
        :maxlength="spec.max"
        :placeholder="aiDefault ?? ''"
        :aria-label="i18n.t(`admin.setting.${name}`)"
        :custom-label="i18n.t('admin.ai_model_custom')"
        class="max-w-64"
      />
      <AppInput v-else :id="id" v-model="value" :maxlength="spec.max" class="max-w-64" :placeholder="aiDefault" />
      <!-- 空值 = 用内置默认模型；下拉没有清空手势，给一个显式入口 -->
      <AppButton v-if="hasModelOptions && value" class="btn-sm" @click="value = ''">
        {{ i18n.t('admin.ai_model_clear') }}
      </AppButton>
      <AppButton v-if="showFetchModels" class="btn-sm" :loading="modelsLoading" @click="emit('fetch-models')">
        {{ i18n.t('admin.ai_fetch_models') }}
      </AppButton>
      <AppButton v-if="showTest" class="btn-sm" :loading="testLoading" @click="emit('test-connection')">
        {{ i18n.t('admin.ai_test') }}
      </AppButton>
    </div>
    <p v-if="testResult" class="text-xs" :class="testResult.includes('✓') ? 'text-green-600' : 'text-red-600'">{{ testResult }}</p>
  </div>
  <AppInput
    v-else-if="multiline"
    :id="id"
    v-model="value"
    multiline
    class="min-h-32"
    :class="['custom_css', 'custom_js', 'ygg_private_key'].includes(name) ? 'font-mono text-xs' : ''"
    :maxlength="spec.max"
    :placeholder="aiDefault"
  />
  <AppInput v-else :id="id" v-model="value" :maxlength="spec.max" :placeholder="name === 'icp_beian' ? i18n.t('admin.icp_beian_placeholder') : name === 'public_security_beian' ? i18n.t('admin.public_security_beian_placeholder') : undefined" />
</template>
