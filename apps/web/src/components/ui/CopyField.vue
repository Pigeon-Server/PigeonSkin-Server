<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import { useI18n } from '@/stores/i18n';
const props = defineProps<{ label: string; value: string; draggable?: boolean }>();
const i18n = useI18n();
const id = useId();
const copied = ref(false);
watch(
  () => props.value,
  () => {
    copied.value = false;
  },
);
const error = ref('');
async function copy() {
  error.value = '';
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
  } catch {
    error.value = i18n.t('integration.copy_failed');
  }
}
function drag(event: DragEvent) {
  if (props.draggable)
    event.dataTransfer?.setData(
      'text/plain',
      `authlib-injector:yggdrasil-server:${encodeURIComponent(props.value)}`,
    );
}
</script>
<template>
  <div class="min-w-0">
    <label :for="id" class="mb-1 block text-xs text-muted">{{ label }}</label>
    <div class="flex min-w-0 gap-2">
      <AppInput
        v-if="value.includes('\n')"
        :id="id"
        :model-value="value"
        readonly
        rows="4"
        multiline
        class="min-w-0 font-mono text-xs"
        @focus="copied = false"
      />
      <AppInput
        v-else
        :id="id"
        :model-value="value"
        readonly
        class="min-w-0 font-mono text-xs"
        @focus="copied = false"
      />
      <AppButton
        :draggable="draggable"
        :aria-label="i18n.t(draggable ? 'integration.launcher.copy_drag' : 'common.copy')"
        @click="copy"
        @dragstart="drag"
      >
        <AppIcon :name="copied ? 'check' : 'content_copy'" />
        {{ i18n.t(copied ? 'common.copied' : 'common.copy') }}
      </AppButton>
    </div>
    <p v-if="error" class="mt-1 text-xs text-danger" role="alert">{{ error }}</p>
  </div>
</template>
