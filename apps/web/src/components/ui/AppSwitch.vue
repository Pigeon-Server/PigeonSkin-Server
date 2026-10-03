<script setup lang="ts">
import { Switch } from '@vuetify/v0';
withDefaults(defineProps<{ label?: string; disabled?: boolean }>(), { label: '', disabled: false });
const model = defineModel<boolean>({ default: false });
</script>
<template>
  <Switch.Root v-model="model" :label="label || undefined" :disabled="disabled" class="app-switch">
    <Switch.Track class="app-switch-track"><Switch.Thumb class="app-switch-thumb" /></Switch.Track>
  </Switch.Root>
</template>
