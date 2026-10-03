<script setup lang="ts">
import { Dialog } from '@vuetify/v0';
import { useI18n } from '@/stores/i18n';
const open = defineModel<boolean>({ default: false });
const props = withDefaults(defineProps<{ title: string; busy?: boolean; dialogClass?: string }>(), { busy: false, dialogClass: '' });
const i18n = useI18n();
</script>
<template>
  <Dialog.Root v-model="open">
    <Dialog.Content class="app-dialog" :class="props.dialogClass" :blocking="!!busy">
      <header class="flex items-center justify-between gap-4 border-b border-line p-5">
        <Dialog.Title class="text-lg font-semibold">{{ title }}</Dialog.Title>
        <AppButton
          class="btn-icon"
          :disabled="busy"
          :aria-label="i18n.t('common.close')"
          @click="open = false"
        >
          <span class="material-icons" aria-hidden="true">close</span>
        </AppButton>
      </header>
      <div class="p-5"><slot /></div>
    </Dialog.Content>
  </Dialog.Root>
</template>
