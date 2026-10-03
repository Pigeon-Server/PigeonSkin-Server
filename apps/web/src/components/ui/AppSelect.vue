<script setup lang="ts">
import { Select } from '@vuetify/v0';
import { computed, useAttrs } from 'vue';

type Option = { value: string | number | null; label: string; disabled?: boolean };
const model = defineModel<string | number | null>({ default: null });
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const props = withDefaults(defineProps<{ options: Option[]; id?: string; placeholder?: string; disabled?: boolean; class?: string; ariaLabel?: string }>(), { placeholder: '', disabled: false, class: '', ariaLabel: '' });
const selectedLabel = computed(() => props.options.find(option => String(option.value) === String(model.value))?.label ?? '');
const emit = defineEmits<{ change: [value: string | number | null] }>();
function update(value: string | number | (string | number | null)[] | null | undefined) {
  const next = Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  model.value = next;
  emit('change', next);
}
</script>

<template>
  <Select.Root :id="id" :model-value="model" :disabled="disabled" @update:model-value="update">
    <Select.Activator v-bind="attrs" class="input app-select-activator" :class="props.class" :aria-label="ariaLabel || undefined">
      <Select.Value>{{ selectedLabel }}</Select.Value>
      <Select.Placeholder>{{ placeholder }}</Select.Placeholder>
      <Select.Cue><AppIcon name="expand_more" class="!text-base" /></Select.Cue>
    </Select.Activator>
    <Select.Content class="app-select-content">
      <Select.Item v-for="option in options" :id="String(option.value)" :key="String(option.value)" :value="option.value" :disabled="option.disabled" class="app-select-item">
        {{ option.label }}
      </Select.Item>
    </Select.Content>
  </Select.Root>
</template>
