<script setup lang="ts">
// 高级搜索帮助：语法速查 + 本入口可用字段。
//
// 字段清单直接来自共享的 SEARCH_SCHEMAS —— 加一个可搜字段不需要改这个组件，
// 也不需要改任何页面；后端能搜什么，这里就显示什么。
import { computed } from 'vue';
import { useI18n } from '@/stores/i18n';
import { fieldDisplayName, searchFieldExample, searchFieldList } from '@/lib/search-expression';
import type { SearchSchemaKey } from '@pigeon-skin/shared/search';
import AppDialog from '@/components/ui/AppDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const props = defineProps<{ schemaKey: SearchSchemaKey }>();
const emit = defineEmits<{ use: [value: string] }>();
const open = defineModel<boolean>({ default: false });
const i18n = useI18n();

/** 语法速查表：写法是字面量，说明走 i18n。 */
const SYNTAX: ReadonlyArray<{ code: string; key: string }> = [
  { code: 'cat', key: 'search.syntax.term' },
  { code: '"summer beach"', key: 'search.syntax.phrase' },
  { code: 'kind:skin', key: 'search.syntax.field' },
  { code: 'kind=skin  kind!=cape', key: 'search.syntax.exact' },
  { code: 'likes>100  created>=2024-01-01', key: 'search.syntax.compare' },
  { code: 'likes:10..100  created:..2024-06', key: 'search.syntax.range' },
  { code: '-kind:cape  NOT kind:cape', key: 'search.syntax.not' },
  { code: 'kind:skin likes>100', key: 'search.syntax.and' },
  { code: 'kind:skin OR kind:cape', key: 'search.syntax.or' },
  { code: '(kind:skin OR kind:cape) likes>100', key: 'search.syntax.group' },
];

const fields = computed(() => searchFieldList(props.schemaKey).map(field => ({
  name: fieldDisplayName(field),
  label: i18n.t(field.labelKey),
  unit: field.unitKey ? i18n.t(field.unitKey) : '',
  example: searchFieldExample(field),
})));

function apply(example: string) {
  emit('use', example);
  open.value = false;
}
</script>

<template>
  <AppDialog v-model="open" :title="i18n.t('search.help.title')">
    <section class="space-y-2">
      <h3 class="text-sm font-semibold">{{ i18n.t('search.help.syntax') }}</h3>
      <ul class="space-y-1 text-sm">
        <li v-for="row in SYNTAX" :key="row.code" class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <code class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{{ row.code }}</code>
          <span class="text-muted">{{ i18n.t(row.key) }}</span>
        </li>
      </ul>
    </section>

    <section class="mt-5 space-y-2">
      <h3 class="text-sm font-semibold">{{ i18n.t('search.help.fields') }}</h3>
      <div class="overflow-x-auto rounded-lg border border-line">
        <table class="table">
          <thead>
            <tr>
              <th>{{ i18n.t('search.help.field_name') }}</th>
              <th>{{ i18n.t('search.help.field_meaning') }}</th>
              <th>{{ i18n.t('search.help.field_example') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in fields" :key="field.name">
              <td class="font-mono text-xs">{{ field.name }}</td>
              <td>
                {{ field.label }}
                <span v-if="field.unit" class="text-muted">（{{ field.unit }}）</span>
              </td>
              <td>
                <AppButton
                  class="btn-sm"
                  :title="i18n.t('search.help.use_example')"
                  @click="apply(field.example)"
                >
                  <AppIcon name="add" class="!text-sm" />
                  <code class="font-mono text-xs">{{ field.example }}</code>
                </AppButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </AppDialog>
</template>
