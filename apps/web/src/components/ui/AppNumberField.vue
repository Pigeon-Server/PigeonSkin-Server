<script setup lang="ts">
import { NumberField } from '@vuetify/v0';
import { computed, useAttrs } from 'vue';
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const model = defineModel<number | null>({ default: null });
const props = withDefaults(defineProps<{ id?: string; min?: number; max?: number; step?: number }>(), { step: 1 });
const rootProps = computed(() => ({ ...(props.min !== undefined ? { min: props.min } : {}), ...(props.max !== undefined ? { max: props.max } : {}), step: props.step }));
</script>
<template>
  <NumberField.Root v-model="model" v-bind="rootProps">
    <div class="number-field-control">
      <NumberField.Decrement class="number-field-step" aria-label="Decrease"><AppIcon name="remove" /></NumberField.Decrement>
      <NumberField.Control v-bind="attrs" :id="props.id" class="input min-w-0 flex-1" />
      <NumberField.Increment class="number-field-step" aria-label="Increase"><AppIcon name="add" /></NumberField.Increment>
    </div>
  </NumberField.Root>
</template>
