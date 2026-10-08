<script setup lang="ts">
import { Combobox } from '@vuetify/v0';
import { FloatingUIPopoverAdapter } from '@vuetify/v0/popover/adapters/floating-ui';
import { flip, offset, shift } from '@floating-ui/dom';
import { computed, useAttrs } from 'vue';
import { useI18n } from '@/stores/i18n';
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const value = defineModel<string>({ default: '' });
const props = withDefaults(
  defineProps<{
    options: string[];
    id?: string | undefined;
    placeholder?: string;
    disabled?: boolean;
    maxlength?: number | undefined;
    ariaLabel?: string | undefined;
    /** 列表外条目的标记文案 */
    customLabel?: string | undefined;
  }>(),
  { id: undefined, placeholder: '', disabled: false, maxlength: undefined, ariaLabel: '', customLabel: '' },
);
const i18n = useI18n();
// 官方 VAutocomplete 的下拉贴着字段左边缘向下展开、下方放不下才翻到上方；
// v0 默认居中，列表比字段宽时会向左探出字段，看着像另一个浮层
const positionAdapter = new FloatingUIPopoverAdapter({
  middleware: [
    offset(6),
    flip(),
    { name: 'alignStart', fn: ({ rects }) => ({ x: rects.reference.x }) },
    shift({ padding: 8 }),
  ],
});
// 已保存的值可能不在拉取到的列表里；补一条同名项，Combobox 才有可显示、可回指的条目
const items = computed(() =>
  value.value && !props.options.includes(value.value) ? [value.value, ...props.options] : props.options,
);
// v0 切换选中项时先清空再写入（同一 tick 内两次），这里把 undefined 收敛成空串，
// 免得把 undefined 写进设置项
const selection = computed<string | null>({
  get: () => value.value || null,
  set: next => {
    value.value = typeof next === 'string' ? next : '';
  },
});
function commit(text: string) {
  const next = text.trim();
  if (next) value.value = next;
}
// 指针按在下拉里（含右侧箭头）：这次失焦来自「选列表」，不能顺手提交 ——
// 一提交值就变、条目跟着重排，抬起的点击会落到别的行上。清空标记放在下一轮宏任务
let listPointerDown = false;
function onListPointerDown() {
  listPointerDown = true;
  setTimeout(() => {
    listPointerDown = false;
  }, 0);
}
// 失焦即收起，并把仍在输入框里的内容当模型名提交（= 允许列表外的手输）。
// 与官方 VAutocomplete 一致：blur 收起菜单，避免同时留下列表
function onFocusOut(query: string, close: () => void) {
  if (listPointerDown) return;
  const next = query.trim();
  if (next) commit(next);
  close();
}
// 回车：下拉里已有可见的高亮项时让 Combobox 自己选中它，否则把输入内容当模型名提交。
// 必须判可见 —— 条目被过滤掉后只是 v-show 隐藏，v0 仍留着 data-highlighted
function onEnter(event: KeyboardEvent, query: string, close: () => void) {
  if (event.key !== 'Enter') return;
  const listboxId = (event.target as HTMLElement | null)?.getAttribute('aria-controls');
  const highlighted = listboxId
    ? document.getElementById(listboxId)?.querySelector<HTMLElement>('[data-highlighted]')
    : null;
  if (highlighted && highlighted.style.display !== 'none') return;
  const next = query.trim();
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  commit(next);
  close();
}
</script>
<template>
  <Combobox.Root v-model="selection" :disabled="disabled" :position-adapter="positionAdapter" v-slot="{ query, close, open }">
    <Combobox.Activator
      v-bind="attrs"
      class="relative block"
      @keydown.capture="(event: KeyboardEvent) => onEnter(event, query, close)"
      @focusout="() => onFocusOut(query, close)"
    >
      <Combobox.Control
        :id="id"
        class="input pr-8 font-mono"
        :placeholder="placeholder || ''"
        :maxlength="maxlength"
        :aria-label="ariaLabel || undefined"
        open-on="input"
        @focus="open()"
      />
      <Combobox.Cue class="absolute inset-y-0 right-2 flex items-center" @mousedown="onListPointerDown">
        <AppIcon name="expand_more" class="text-muted" />
      </Combobox.Cue>
    </Combobox.Activator>
    <Combobox.Content eager class="app-select-content" @mousedown="onListPointerDown">
      <Combobox.Item v-for="option in items" :id="option" :key="option" :value="option" class="app-select-item font-mono">
        {{ option }}
        <span v-if="customLabel && !options.includes(option)" class="ml-2 text-xs text-muted">{{ customLabel }}</span>
      </Combobox.Item>
      <Combobox.Empty class="p-3 text-sm text-muted">{{ i18n.t('general.noResult') }}</Combobox.Empty>
    </Combobox.Content>
  </Combobox.Root>
</template>
