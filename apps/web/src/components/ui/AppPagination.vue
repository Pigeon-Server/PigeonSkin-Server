<script setup lang="ts">
import { Pagination } from '@vuetify/v0';
import { useI18n } from '@/stores/i18n';
const page = defineModel<number>({ required: true });
const props = defineProps<{ totalPages: number; busy?: boolean }>();
const i18n = useI18n();
</script>
<template>
  <Pagination.Root
    v-if="props.totalPages > 1"
    v-model="page"
    :size="props.totalPages"
    :items-per-page="1"
    :total-visible="1"
    class="pagination"
  >
    <template #default="{ isFirst, isLast, prev, next }">
      <div class="pagination-controls">
        <AppButton :disabled="isFirst || props.busy" @click="prev">
          <AppIcon name="chevron_left" />{{ i18n.t('common.prev') }}
        </AppButton>
        <span>{{ i18n.t('common.page_of', { page: i18n.n(page), total: i18n.n(props.totalPages) }) }}</span>
        <AppButton :disabled="isLast || props.busy" @click="next">
          {{ i18n.t('common.next') }}<AppIcon name="chevron_right" />
        </AppButton>
      </div>
    </template>
  </Pagination.Root>
</template>
