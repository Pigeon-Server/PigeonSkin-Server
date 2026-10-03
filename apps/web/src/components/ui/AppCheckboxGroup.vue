<script setup lang="ts">
import { Checkbox } from '@vuetify/v0';
type Option = { value: string | number; label: string; disabled?: boolean };
withDefaults(defineProps<{ options: Option[]; disabled?: boolean; class?: string }>(), { disabled: false, class: '' });
const model = defineModel<Array<string | number>>({ default: () => [] });
</script>
<template>
  <Checkbox.Group v-model="model" :disabled="disabled" :class="$props.class">
    <div v-for="option in options" :key="String(option.value)" class="app-checkbox-option" :data-disabled="option.disabled || disabled || undefined">
      <Checkbox.Root :value="option.value" :label="option.label" :disabled="option.disabled || disabled" class="app-checkbox">
        <Checkbox.Indicator class="app-checkbox-indicator"><AppIcon name="check" class="!text-sm" /></Checkbox.Indicator>
      </Checkbox.Root>
      <span @click="!option.disabled && !disabled && (model = model.includes(option.value) ? model.filter(value => value !== option.value) : [...model, option.value])">{{ option.label }}</span>
    </div>
  </Checkbox.Group>
</template>
