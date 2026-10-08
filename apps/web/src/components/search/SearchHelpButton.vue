<script setup lang="ts">
// 高级搜索入口按钮：自管帮助弹窗，任何搜索框旁边都能直接放一个。
import { ref } from 'vue';
import { useI18n } from '@/stores/i18n';
import type { SearchSchemaKey } from '@pigeon-skin/shared/search';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import SearchHelpDialog from './SearchHelpDialog.vue';

const props = defineProps<{ schemaKey: SearchSchemaKey; compact?: boolean | undefined }>();
const emit = defineEmits<{ use: [value: string] }>();
const i18n = useI18n();
const open = ref(false);
</script>

<template>
  <AppButton
    type="button"
    class="btn-icon shrink-0"
    :class="props.compact ? 'btn-sm' : ''"
    :title="i18n.t('search.advanced')"
    :aria-label="i18n.t('search.advanced')"
    @click="open = true"
  >
    <AppIcon name="tune" />
  </AppButton>
  <SearchHelpDialog v-model="open" :schema-key="props.schemaKey" @use="emit('use', $event)" />
</template>
