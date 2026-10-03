<script setup lang="ts">
import { computed, ref } from 'vue';
import { restrictedEmailListSchema } from '@pigeon-skin/shared/schemas';
import { useI18n } from '@/stores/i18n';
const value = defineModel<string | undefined>({ default: '[]' });
defineProps<{ id?: string }>();
const i18n = useI18n();
const input = ref('');
const error = ref('');
const domains = computed<string[]>(() => {
  try {
    const parsed = JSON.parse(value.value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
});
function add() {
  const next = input.value.trim().toLowerCase();
  const parsed = restrictedEmailListSchema.safeParse({
    domains: [...new Set([...domains.value, next])],
  });
  if (!parsed.success) {
    error.value = i18n.t('integration.domains.invalid');
    return;
  }
  value.value = JSON.stringify(parsed.data.domains);
  input.value = '';
  error.value = '';
}
function remove(domain: string) {
  value.value = JSON.stringify(domains.value.filter((item) => item !== domain));
}
</script>
<template>
  <div class="space-y-2 min-w-0">
    <div class="flex gap-2">
      <AppInput
        :id="id"
        v-model="input"
        class="min-w-0"
        :aria-label="id ? undefined : i18n.t('integration.domains.domain')"
        :placeholder="i18n.t('integration.domains.placeholder')"
        @keydown.enter.prevent="add"
      />
      <AppButton :disabled="!input.trim()" @click="add">
        <AppIcon name="add" />
        {{ i18n.t('common.add') }}
      </AppButton>
    </div>
    <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
    <div class="flex flex-wrap gap-2">
      <span
        v-for="domain in domains"
        :key="domain"
        class="inline-flex items-center gap-1 rounded border border-line bg-surface-2 py-1 pl-2 text-xs"
      >
        <span>{{ domain }}</span>
        <AppButton
          class="btn-icon btn-sm !border-0 !bg-transparent !p-0"
          :aria-label="i18n.t('integration.domains.remove', { domain })"
          @click="remove(domain)"
        >
          <AppIcon name="close" class="!text-sm" />
        </AppButton>
      </span>
    </div>
    <p v-if="!domains.length" class="text-xs text-muted">
      {{ i18n.t('integration.domains.empty') }}
    </p>
  </div>
</template>
