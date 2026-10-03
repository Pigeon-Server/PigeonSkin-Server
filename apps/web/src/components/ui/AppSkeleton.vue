<script setup lang="ts">
import { useI18n } from '@/stores/i18n';
withDefaults(defineProps<{ count?: number }>(), { count: 6 });
const i18n = useI18n();
</script>
<template><div class="texture-grid" role="status" :aria-label="i18n.t('common.loading')"><div v-for="n in count" :key="n" class="skeleton resource-grid-skeleton" /></div></template>
