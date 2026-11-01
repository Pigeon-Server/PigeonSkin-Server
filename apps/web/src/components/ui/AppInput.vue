<script setup lang="ts">
import { Input } from '@vuetify/v0';
import { computed, ref, useAttrs } from 'vue';
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const control = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
const model = defineModel<string>({ default: '' });
const props = withDefaults(defineProps<{ id?: string; type?: string; multiline?: boolean }>(), { type: 'text', multiline: false });
// 裸 required 在 attrs 里是空串（HTML 布尔属性），:required="false" 则是真正的 false；
// 旧实现用 `!== undefined` 判断，把显式传入的 false 也当成了必填。
const isRequired = computed(() => {
  const value = attrs.required;
  return value === '' || value === true || value === 'true';
});
const rootProps = computed(() => ({
  ...(props.id ? { id: props.id } : {}),
  ...(props.type ? { type: props.type } : {}),
  required: isRequired.value,
}));
defineExpose({ focus: () => control.value?.focus(), select: () => control.value?.select() });
</script>
<template>
  <Input.Root v-model="model" v-bind="{ ...attrs, ...rootProps }">
    <Input.Control ref="control" v-bind="attrs" :as="props.multiline ? 'textarea' : 'input'" class="input" />
  </Input.Root>
</template>
