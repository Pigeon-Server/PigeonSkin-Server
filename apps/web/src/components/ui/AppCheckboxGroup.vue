<script setup lang="ts">
type Option = { value: string | number; label: string; disabled?: boolean };
const props = withDefaults(defineProps<{ options: Option[]; disabled?: boolean; class?: string }>(), { disabled: false, class: '' });
const model = defineModel<Array<string | number>>({ default: () => [] });
const frozen = (option: Option) => props.disabled || !!option.disabled;
function toggle(option: Option) {
  if (frozen(option)) return;
  model.value = model.value.includes(option.value)
    ? model.value.filter(value => value !== option.value)
    : [...model.value, option.value];
}
</script>
<template>
  <!-- 同 AppRadioGroup：v0 Checkbox 的 disabled 会冻结选中显示，"已投票"场景需要
       disabled + checked 并存 —— 这里自绘受控 checkbox。 -->
  <div :class="$props.class" role="group">
    <div
      v-for="option in options"
      :key="String(option.value)"
      class="app-checkbox-option"
      :data-disabled="frozen(option) || undefined"
      @click="toggle(option)"
    >
      <button
        type="button"
        role="checkbox"
        class="app-checkbox"
        :aria-checked="model.includes(option.value)"
        :aria-disabled="frozen(option) || undefined"
        :data-state="model.includes(option.value) ? 'checked' : 'unchecked'"
        :tabindex="frozen(option) ? -1 : 0"
        @keydown.space.prevent="toggle(option)"
      >
        <span v-if="model.includes(option.value)" class="app-checkbox-indicator"><AppIcon name="check" class="!text-sm" /></span>
      </button>
      <span class="cursor-pointer">{{ option.label }}</span>
    </div>
  </div>
</template>
