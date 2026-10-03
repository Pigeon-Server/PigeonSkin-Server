<script setup lang="ts">
import { Button } from '@vuetify/v0';
import { mergeProps, useAttrs } from 'vue';
import AppTooltip from '@/components/ui/AppTooltip.vue';
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
withDefaults(
  defineProps<{
    loading?: boolean | undefined;
    disabled?: boolean | undefined;
    type?: 'button' | 'submit' | 'reset' | undefined;
  }>(),
  { type: 'button', loading: false, disabled: false },
);
</script>
<template>
  <AppTooltip
    v-if="(attrs['aria-label'] || attrs.title) && String(attrs.class).includes('btn-icon')"
    :text="String(attrs['aria-label'] || attrs.title)"
    v-slot="{ attrs: tooltipAttrs }"
  >
    <Button.Root renderless :loading="loading" :disabled="disabled || loading" v-slot="button">
      <button
        v-bind="mergeProps(button.attrs, tooltipAttrs, attrs)"
        :type="type"
        :disabled="button.isDisabled"
        :aria-busy="loading"
        class="btn"
      >
        <span v-if="loading" class="material-icons animate-spin" aria-hidden="true">sync</span>
        <slot />
      </button>
    </Button.Root>
  </AppTooltip>
  <Button.Root v-else renderless :loading="loading" :disabled="disabled || loading" v-slot="button">
    <button
      v-bind="mergeProps(button.attrs, attrs)"
      :type="type"
      :disabled="button.isDisabled"
      :aria-busy="loading"
      class="btn"
    >
      <span v-if="loading" class="material-icons animate-spin" aria-hidden="true">sync</span>
      <slot />
    </button>
  </Button.Root>
</template>
