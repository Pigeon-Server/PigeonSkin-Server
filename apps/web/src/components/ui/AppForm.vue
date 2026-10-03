<script setup lang="ts">
import { Form } from '@vuetify/v0';
import { useAttrs } from 'vue';
import { createSubmitEvent } from './app-form';

defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const emit = defineEmits<{ submit: [event: SubmitEvent & { valid: boolean }]; reset: [] }>();
function submitted(payload: { valid: boolean }) {
  emit('submit', createSubmitEvent(payload.valid));
}
</script>

<template>
  <Form v-bind="attrs" :novalidate="false" @submit="submitted" @reset="emit('reset')">
    <slot />
  </Form>
</template>
