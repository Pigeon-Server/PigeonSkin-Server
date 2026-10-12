<script setup lang="ts">
// 悬停/聚焦时在行旁浮出一张材质卡。
//
// 列表里 40px 的缩略图看不清材质本身，点进详情页又太重 —— 浮层给出放大预览
// 与关键元信息。浮层 Teleport 到 body：表格容器是 overflow-x-auto，就地渲染
// 会被裁掉；定位交给 floating-ui，贴边时自动翻到上方。
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import { previewUrl } from '@/api';
import { useI18n } from '@/stores/i18n';

defineProps<{
  texture: {
    hash: string;
    kind: 'skin' | 'cape';
    model: 'default' | 'slim' | null;
    name: string;
    visibility: 'public' | 'private';
    official: boolean;
    uploaderName: string | null;
    likes: number;
    createdAt: number;
  };
}>();

/** 悬停多久才弹：太灵敏会在鼠标扫过列表时一直闪 */
const SHOW_DELAY = 220;
/** 收回的缓冲：从名字移向相邻控件时不至于立刻消失 */
const HIDE_DELAY = 120;

const i18n = useI18n();
const trigger = useTemplateRef<HTMLElement>('trigger');
const panel = useTemplateRef<HTMLElement>('panel');
const open = ref(false);

let timer: ReturnType<typeof setTimeout> | undefined;
let stopTracking: (() => void) | undefined;
/** 触屏/无悬停设备不弹：那里没有"悬停"，浮层只会挡住点击 */
let hoverCapable = true;

function place() {
  const reference = trigger.value;
  const floating = panel.value;
  if (!reference || !floating) return;
  void computePosition(reference, floating, {
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  })
    .then(({ x, y }) => {
      floating.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    })
    // 面板在定位完成前就被收起/卸载时忽略即可
    .catch(() => {});
}

function show() {
  if (!hoverCapable) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    // 收起缓冲期内又移回来：面板还开着，不能再注册一个 autoUpdate
    if (open.value) return;
    open.value = true;
    void nextTick(() => {
      place();
      const reference = trigger.value;
      const floating = panel.value;
      if (reference && floating) stopTracking = autoUpdate(reference, floating, place);
    });
  }, SHOW_DELAY);
}

function hide() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    open.value = false;
    stopTracking?.();
    stopTracking = undefined;
  }, HIDE_DELAY);
}

onMounted(() => {
  hoverCapable = typeof window.matchMedia !== 'function'
    || window.matchMedia('(hover: hover) and (pointer: fine)').matches;
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  stopTracking?.();
});
</script>

<template>
  <span
    ref="trigger"
    class="inline-flex min-w-0"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
  >
    <slot />
  </span>
  <Teleport to="body">
    <!-- pointer-events:none：浮层永远不接收指针，它盖住的行与按钮照常可点 -->
    <div
      v-if="open"
      ref="panel"
      class="texture-hover-card pointer-events-none fixed left-0 top-0 w-56 rounded-xl border border-line bg-surface p-3 shadow-lg"
      aria-hidden="true"
    >
      <div class="flex h-40 items-center justify-center rounded-lg bg-surface-2 p-1">
        <img
          :src="previewUrl(texture.hash, texture)"
          :alt="texture.name"
          class="max-h-full max-w-full object-contain"
        />
      </div>

      <div class="mt-2 flex items-start justify-between gap-2">
        <span class="min-w-0 flex-1 truncate font-medium" :title="texture.name">{{ texture.name }}</span>
        <span class="badge shrink-0">
          {{ texture.kind === 'cape'
            ? i18n.t('general.cape')
            : i18n.t(texture.model === 'slim' ? 'skinlib.model_slim' : 'skinlib.model_classic') }}
        </span>
      </div>

      <div class="mt-1.5 flex flex-wrap gap-1">
        <span v-if="texture.official" class="badge badge-success">{{ i18n.t('skinlib.official_resource') }}</span>
        <span v-if="texture.visibility === 'private'" class="badge badge-warning">
          <AppIcon name="lock" class="!text-xs" />{{ i18n.t('skinlib.private') }}
        </span>
      </div>

      <dl class="mt-2 space-y-1 text-xs text-muted">
        <!-- 官方材质的上传者就是官方，徽标已经说明，不必再重复一行 -->
        <div v-if="!texture.official" class="flex justify-between gap-2">
          <dt>{{ i18n.t('skinlib.show.uploader') }}</dt>
          <dd class="truncate">{{ texture.uploaderName ?? i18n.t('admin.anonymous') }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>{{ i18n.t('search.field.created') }}</dt>
          <dd>{{ i18n.d(texture.createdAt) }}</dd>
        </div>
        <div class="flex justify-between gap-2">
          <dt>{{ i18n.t('skinlib.show.likes') }}</dt>
          <dd>{{ i18n.n(texture.likes) }}</dd>
        </div>
      </dl>
    </div>
  </Teleport>
</template>

<style scoped>
@media (prefers-reduced-motion: no-preference) {
  .texture-hover-card {
    animation: texture-hover-card-in 120ms ease-out;
  }
}

@keyframes texture-hover-card-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
