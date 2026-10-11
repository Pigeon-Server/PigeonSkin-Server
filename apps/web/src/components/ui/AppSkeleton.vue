<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@/stores/i18n';

/**
 * 骨架屏形态应与实际内容一致：
 * - grid   材质卡片网格（texture-grid）
 * - table  数据表格（行 + 若干单元格）
 * - list   垂直条目列表（每条目含主文本行 + 次要行）
 * - stats  统计卡网格（图标 + 大数字）
 * - form   纵向表单（标签 + 输入行）
 * - detail 单列详情流（标题 + 段落块）
 */
const props = withDefaults(
  defineProps<{
    count?: number;
    variant?: 'grid' | 'table' | 'list' | 'stats' | 'form' | 'detail';
    /** table/stats 的列数；缺省时 table 固定 6 列、stats 自适应 */
    columns?: number;
  }>(),
  { count: 6, variant: 'grid' },
);

const i18n = useI18n();

const blocks = computed(() => Array.from({ length: props.count }, (_, i) => i));
const tableColumns = computed(() => props.columns ?? 6);
const statsColumns = computed(() =>
  props.columns ? `repeat(${props.columns}, minmax(0, 1fr))` : 'repeat(auto-fit, minmax(150px, 1fr))',
);
</script>

<template>
  <div
    role="status"
    :aria-label="i18n.t('common.loading')"
  >
    <!-- 材质卡片网格：与 texture-grid 同构 -->
    <div v-if="variant === 'grid'" class="texture-grid">
      <div v-for="n in blocks" :key="n" class="skeleton resource-grid-skeleton" />
    </div>

    <!-- 数据表格：表头行 + count 行内容 -->
    <div
      v-else-if="variant === 'table'"
      class="overflow-x-auto rounded-xl border border-line bg-surface"
    >
      <div class="min-w-max">
        <div class="flex gap-6 border-b border-line px-4 py-3">
          <div
            v-for="c in tableColumns"
            :key="c"
            class="skeleton h-3 rounded"
            :style="{ width: `${52 + (c % 3) * 14}px` }"
          />
        </div>
        <div
          v-for="r in blocks"
          :key="r"
          class="flex items-center gap-6 border-b border-line px-4 py-3.5 last:border-b-0"
        >
          <div
            v-for="c in tableColumns"
            :key="c"
            class="skeleton h-3.5 rounded"
            :class="c === 1 ? 'w-8' : ''"
            :style="c === 1 ? undefined : { width: `${64 + ((c * 7 + r * 13) % 5) * 18}px` }"
          />
        </div>
      </div>
    </div>

    <!-- 垂直条目列表：主行 + 次行 -->
    <div v-else-if="variant === 'list'" class="space-y-3">
      <div
        v-for="r in blocks"
        :key="r"
        class="flex items-center gap-4 rounded-lg border border-line px-4 py-3.5"
      >
        <div class="skeleton h-9 w-9 shrink-0 rounded-full" />
        <div class="min-w-0 flex-1 space-y-2">
          <div class="skeleton h-3.5 rounded" :style="{ width: `${34 + ((r * 17) % 4) * 12}%` }" />
          <div class="skeleton h-3 rounded" :style="{ width: `${56 + ((r * 23) % 3) * 10}%` }" />
        </div>
        <div class="skeleton h-6 w-14 shrink-0 rounded-full" />
      </div>
    </div>

    <!-- 统计卡网格：图标 + 标签 + 大数字 -->
    <div
      v-else-if="variant === 'stats'"
      class="grid gap-3"
      :style="{ gridTemplateColumns: statsColumns }"
    >
      <div v-for="n in blocks" :key="n" class="rounded-lg border border-line p-4">
        <div class="flex items-center justify-between">
          <div class="skeleton h-3 w-14 rounded" />
          <div class="skeleton h-5 w-5 rounded" />
        </div>
        <div class="skeleton mt-3 h-7 w-20 rounded" />
      </div>
    </div>

    <!-- 纵向表单：标签行 + 输入行 -->
    <div v-else-if="variant === 'form'" class="space-y-4">
      <div v-for="n in blocks" :key="n" class="space-y-2">
        <div class="skeleton h-3 rounded" :style="{ width: `${24 + (n % 3) * 8}%` }" />
        <div class="skeleton h-10 rounded-md" />
      </div>
    </div>

    <!-- 单列详情流：标题 + 段落行 -->
    <div v-else class="space-y-4">
      <div class="skeleton h-6 w-2/5 rounded" />
      <div v-for="n in blocks" :key="n" class="space-y-2">
        <div class="skeleton h-3.5 rounded" :style="{ width: n % 4 === 0 ? '62%' : '100%' }" />
        <div class="skeleton h-3.5 rounded" :style="{ width: n % 3 === 0 ? '45%' : '92%' }" />
      </div>
    </div>
  </div>
</template>
