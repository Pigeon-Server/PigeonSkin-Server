<script setup lang="ts">
import { ref, useId } from 'vue';
import { useI18n } from '@/stores/i18n';
const value = defineModel<string>({ default: '' });
withDefaults(defineProps<{ label: string; limit?: number; disabled?: boolean }>(), {
  limit: 0,
  disabled: false,
});
const i18n = useI18n();
const id = useId();
const mode = ref<'edit' | 'preview'>('edit');
</script>
<template>
  <div>
    <div class="mb-2 flex items-center justify-between gap-2">
      <label :for="id" class="font-medium text-sm">{{ label }}</label>
      <div class="filter-tabs">
        <AppButton class="btn-sm" :class="{ selected: mode === 'edit' }" @click="mode = 'edit'">
          {{ i18n.t('common.edit') }}
        </AppButton>
        <AppButton
          class="btn-sm"
          :class="{ selected: mode === 'preview' }"
          @click="mode = 'preview'"
        >
          {{ i18n.t('common.preview') }}
        </AppButton>
      </div>
    </div>
    <textarea
      v-if="mode === 'edit'"
      :id="id"
      v-model="value"
      :disabled="disabled"
      :maxlength="limit || undefined"
      class="input min-h-32 resize-y"
      :placeholder="i18n.t('integration.description.placeholder')"
    />
    <div v-else class="min-h-32 rounded border border-line bg-surface-2 p-3">
      <MarkdownContent v-if="value" :content="value" />
      <p v-else class="text-sm text-muted">{{ i18n.t('skinlib.description_empty') }}</p>
    </div>
    <div class="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
      <span>{{ i18n.t('integration.description.markdown') }}</span>
      <span>
        {{ limit ? i18n.t('common.characters', { count: i18n.n(value.length), max: i18n.n(limit) }) : i18n.n(value.length) }}
      </span>
    </div>
  </div>
</template>
