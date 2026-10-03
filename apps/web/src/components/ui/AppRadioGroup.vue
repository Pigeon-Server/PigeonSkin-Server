<script setup lang="ts">
import { ref } from 'vue';
type Option = { value: string | number; label: string; description?: string; disabled?: boolean };
const props = withDefaults(defineProps<{ options: Option[]; name?: string; disabled?: boolean; class?: string }>(), { disabled: false, class: '' });
const model = defineModel<string | number | null>({ default: null });
const buttons = ref<Array<HTMLElement | null>>([]);
// v0 Radio 的 disabled 会冻结 selection 本身（选中显示随之丢失），而"已投票"
// 需要 disabled + checked 并存 —— 这里自绘受控 radio，disabled 只拦截交互。
const frozen = (option: Option) => props.disabled || !!option.disabled;
function choose(option: Option) {
  if (frozen(option)) return;
  model.value = option.value;
}
function tabbable(index: number) {
  if (model.value === props.options[index]?.value) return true;
  const selectableBefore = props.options.slice(0, index).filter(option => !frozen(option)).length;
  return model.value === null && !frozen(props.options[index]!) && selectableBefore === 0;
}
function onKeydown(event: KeyboardEvent, index: number) {
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    choose(props.options[index]!);
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const pool = props.options.map((option, position) => ({ option, position })).filter(({ option }) => !frozen(option));
  if (!pool.length) return;
  const current = pool.findIndex(({ position }) => position === index);
  const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
  const next = pool[((current === -1 ? 0 : current) + step + pool.length) % pool.length] ?? pool[0]!;
  model.value = next.option.value;
  buttons.value[next.position]?.focus();
}
</script>
<template>
  <div :class="$props.class" role="radiogroup">
    <div
      v-for="(option, index) in options"
      :key="String(option.value)"
      class="app-radio-option"
      :data-disabled="frozen(option) || undefined"
      @click="choose(option)"
    >
      <button
        :id="`${props.name || 'radio-group'}-${index}`"
        :ref="element => { buttons[index] = element as HTMLElement | null }"
        type="button"
        role="radio"
        class="app-radio"
        :aria-checked="model === option.value"
        :aria-disabled="frozen(option) || undefined"
        :data-state="model === option.value ? 'checked' : 'unchecked'"
        :tabindex="tabbable(index) ? 0 : -1"
        @keydown="onKeydown($event, index)"
      >
        <span v-if="model === option.value" class="app-radio-indicator" />
      </button>
      <span>
        <span class="block">{{ option.label }}</span>
        <span v-if="option.description" class="block text-sm text-muted mt-1">{{ option.description }}</span>
      </span>
    </div>
  </div>
</template>
