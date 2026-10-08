<script setup lang="ts">
// 通用搜索输入框：支持高级搜索表达式，并带语法帮助入口。
//
// 表达式写错不会拦下用户：解析不了的输入按普通关键词处理（与后端一致），
// 因此这里不做错误提示，也不需要提交守卫。提交由父级通过 @submit（回车）
// 或页面自己的表单按钮触发。
import { computed, useAttrs } from 'vue';
import { appendSearchExample } from '@/lib/search-expression';
import { SEARCH_LIMITS } from '@pigeon-skin/shared/search';
import type { SearchSchemaKey } from '@pigeon-skin/shared/search';
import AppInput from '@/components/ui/AppInput.vue';
import SearchHelpButton from './SearchHelpButton.vue';

defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
// class/style 落在容器上（决定布局尺寸），其余属性（clearable、maxlength…）转给输入框本身
const rootAttrs = computed(() => ({ class: attrs.class, style: attrs.style }));
const inputAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs;
  return rest;
});
const model = defineModel<string>({ default: '' });
const props = defineProps<{
  schemaKey: SearchSchemaKey;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
  /** 用于密集工具栏（按钮更小） */
  compact?: boolean | undefined;
}>();
const emit = defineEmits<{ submit: [] }>();
</script>

<template>
  <div class="search-expression" v-bind="rootAttrs">
    <div class="flex items-center gap-1">
      <AppInput
        v-bind="inputAttrs"
        v-model="model"
        class="flex-1 min-w-0"
        :maxlength="SEARCH_LIMITS.maxLength"
        :placeholder="props.placeholder ?? ''"
        :aria-label="props.ariaLabel ?? ''"
        @keyup.enter="emit('submit')"
      />
      <SearchHelpButton :schema-key="props.schemaKey" :compact="props.compact ?? false" @use="model = appendSearchExample(model, $event)" />
    </div>
  </div>
</template>
