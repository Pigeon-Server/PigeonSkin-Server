<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@/stores/i18n';

const page = defineModel<number>({ required: true });
const props = withDefaults(
  defineProps<{
    totalPages: number;
    busy?: boolean | undefined;
    showPages?: boolean | undefined;
    maxVisible?: number | undefined;
  }>(),
  {
    busy: false,
    showPages: false,
    maxVisible: 7,
  },
);

const i18n = useI18n();

const visiblePages = computed(() => {
  const total = props.totalPages;
  const current = page.value;
  const max = props.maxVisible;

  if (total <= max) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | '...')[] = [];
  const half = Math.floor((max - 2) / 2);
  let start = Math.max(2, current - half);
  let end = Math.min(total - 1, current + half);

  if (current - 1 <= half) {
    end = Math.min(total - 1, max - 2);
  } else if (total - current <= half) {
    start = Math.max(2, total - (max - 3));
  }

  pages.push(1);
  if (start > 2) pages.push('...');
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }
  if (end < total - 1) pages.push('...');
  pages.push(total);

  return pages;
});

function goTo(p: number) {
  if (props.busy || p === page.value || p < 1 || p > props.totalPages) return;
  page.value = p;
}
</script>

<template>
  <nav
    v-if="props.totalPages > 1"
    class="pagination"
    :aria-label="i18n.t('common.page_of', { page: i18n.n(page), total: i18n.n(props.totalPages) })"
  >
    <div class="pagination-controls">
      <AppButton
        :disabled="page <= 1 || props.busy"
        :aria-label="i18n.t('common.prev')"
        @click="goTo(page - 1)"
      >
        <AppIcon name="chevron_left" />
        <span class="hidden sm:inline">{{ i18n.t('common.prev') }}</span>
      </AppButton>

      <div v-if="props.showPages" class="pagination-pages hidden sm:flex">
        <template v-for="(p, idx) in visiblePages" :key="idx">
          <span v-if="p === '...'" class="pagination-ellipsis px-1.5 text-muted">…</span>
          <AppButton
            v-else
            class="pagination-page-btn"
            :class="{ active: page === p, '!border-brand-500 !bg-brand-500 !text-white': page === p }"
            :disabled="props.busy"
            :aria-current="page === p ? 'page' : undefined"
            @click="goTo(p)"
          >
            {{ i18n.n(p) }}
          </AppButton>
        </template>
      </div>

      <span class="pagination-summary" :class="{ 'sm:hidden': props.showPages }">
        {{ i18n.t('common.page_of', { page: i18n.n(page), total: i18n.n(props.totalPages) }) }}
      </span>

      <AppButton
        :disabled="page >= props.totalPages || props.busy"
        :aria-label="i18n.t('common.next')"
        @click="goTo(page + 1)"
      >
        <span class="hidden sm:inline">{{ i18n.t('common.next') }}</span>
        <AppIcon name="chevron_right" />
      </AppButton>
    </div>
  </nav>
</template>
