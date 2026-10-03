<script setup lang="ts">
import { Radio } from '@vuetify/v0';
type Option = { value: string | number; label: string; description?: string; disabled?: boolean };
withDefaults(defineProps<{ options: Option[]; name?: string; disabled?: boolean; class?: string }>(), { disabled: false, class: '' });
const model = defineModel<string | number | null>({ default: null });
</script>
<template>
  <Radio.Group v-model="model" :name="name" :disabled="disabled" :class="$props.class">
    <div v-for="option in options" :key="String(option.value)" class="app-radio-option" :data-disabled="option.disabled || disabled || undefined">
      <Radio.Root :value="option.value" :label="option.label" :disabled="option.disabled || disabled" class="app-radio">
        <Radio.Indicator class="app-radio-indicator" />
      </Radio.Root>
      <span @click="!option.disabled && !disabled && (model = option.value)"><span class="block">{{ option.label }}</span><span v-if="option.description" class="block text-sm text-muted mt-1">{{ option.description }}</span></span>
    </div>
  </Radio.Group>
</template>
