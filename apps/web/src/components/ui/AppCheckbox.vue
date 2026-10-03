<script setup lang="ts">
import { Checkbox } from '@vuetify/v0';
withDefaults(defineProps<{ label?: string; disabled?: boolean; value?: string | number }>(), { label: '', disabled: false });
const model = defineModel<boolean>({ default: false });
</script>
<template>
  <Checkbox.Root v-model="model" :label="label || undefined" :value="value" :disabled="disabled" class="app-checkbox">
    <Checkbox.Indicator class="app-checkbox-indicator"><AppIcon name="check" class="!text-sm" /></Checkbox.Indicator>
  </Checkbox.Root>
</template>
