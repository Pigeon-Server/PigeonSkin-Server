<script setup lang="ts">
import { Input } from '@vuetify/v0';
import { computed, ref, useAttrs } from 'vue';
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const control = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
const model = defineModel<string>({ default: '' });
const props = withDefaults(defineProps<{ id?: string; type?: string; multiline?: boolean }>(), { type: 'text', multiline: false });
const rootProps = computed(() => ({ ...(props.id ? { id: props.id } : {}), ...(props.type ? { type: props.type } : {}), required: attrs.required !== undefined }));
defineExpose({ focus: () => control.value?.focus(), select: () => control.value?.select() });
</script>
<template>
  <Input.Root v-model="model" v-bind="{ ...attrs, ...rootProps }">
    <Input.Control ref="control" v-bind="attrs" :as="props.multiline ? 'textarea' : 'input'" class="input" />
  </Input.Root>
</template>
