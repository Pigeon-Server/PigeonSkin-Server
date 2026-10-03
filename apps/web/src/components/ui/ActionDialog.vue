<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { dialogState } from '@/stores/dialog';
import { useI18n } from '@/stores/i18n';
const i18n = useI18n();
const value = ref('');
const input = ref<{ focus: () => void; select: () => void } | null>(null);
const open = computed({
  get: () => !!dialogState.value,
  set: (v) => {
    if (!v) finish(null);
  },
});
watch(dialogState, async (s) => {
  value.value = s?.initial ?? '';
  if (s?.input) {
    await nextTick();
    requestAnimationFrame(() => { input.value?.focus(); input.value?.select(); });
  }
});
function finish(result: string | boolean | null) {
  dialogState.value?.resolve(result);
  dialogState.value = null;
}
</script>
<template>
  <AppDialog v-model="open" :title="dialogState?.title ?? ''">
    <AppForm @submit.prevent="finish(dialogState?.input ? value : true)">
      <AppInput
        v-if="dialogState?.input"
        ref="input"
        v-model="value"
        :type="dialogState.type"
        :aria-label="dialogState.title"
        autofocus
        required
      />
      <div class="mt-5 flex justify-end gap-2">
        <AppButton @click="finish(null)">{{ i18n.t('common.cancel') }}</AppButton>
        <AppButton type="submit" class="btn-primary">
          {{ i18n.t('common.confirm_action') }}
        </AppButton>
      </div>
    </AppForm>
  </AppDialog>
</template>
