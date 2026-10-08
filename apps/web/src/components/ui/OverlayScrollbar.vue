<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{ target: HTMLElement | null; label: string }>();
const track = ref<HTMLElement | null>(null);
const height = ref(0);
const scrollHeight = ref(0);
const scrollTop = ref(0);
const trackHeight = ref(0);
const dragging = ref(false);
let grabOffset = 0;
const maximum = computed(() => Math.max(0, scrollHeight.value - height.value));
const thumbHeight = computed(() => scrollHeight.value ? Math.min(trackHeight.value, Math.max(28, trackHeight.value * height.value / scrollHeight.value)) : 0);
const travel = computed(() => Math.max(0, trackHeight.value - thumbHeight.value));
const thumbTop = computed(() => maximum.value ? scrollTop.value / maximum.value * travel.value : 0);
const percentage = computed(() => maximum.value ? Math.round(scrollTop.value / maximum.value * 100) : 0);

function measure() {
  height.value = props.target?.clientHeight ?? 0;
  scrollHeight.value = props.target?.scrollHeight ?? 0;
  scrollTop.value = Math.max(0, Math.min(Math.max(0, scrollHeight.value - height.value), props.target?.scrollTop ?? 0));
  trackHeight.value = track.value?.clientHeight ?? 0;
}

function scrollTo(top: number) {
  if (!props.target) return;
  props.target.scrollTop = Math.max(0, Math.min(maximum.value, top));
  measure();
}

function dragTo(event: PointerEvent) {
  if (!dragging.value || !track.value || !travel.value) return;
  scrollTo((event.clientY - track.value.getBoundingClientRect().top - grabOffset) / travel.value * maximum.value);
}

function startDrag(event: PointerEvent) {
  if (event.button !== 0 || !track.value) return;
  const y = event.clientY - track.value.getBoundingClientRect().top;
  grabOffset = y >= thumbTop.value && y <= thumbTop.value + thumbHeight.value
    ? y - thumbTop.value
    : thumbHeight.value / 2;
  dragging.value = true;
  track.value.setPointerCapture(event.pointerId);
  track.value.focus({ preventScroll: true });
  dragTo(event);
}

function stopDrag() {
  dragging.value = false;
}

function onKeydown(event: KeyboardEvent) {
  const offsets: Record<string, number> = {
    ArrowUp: scrollTop.value - 40,
    ArrowDown: scrollTop.value + 40,
    PageUp: scrollTop.value - height.value,
    PageDown: scrollTop.value + height.value,
    Home: 0,
    End: maximum.value,
  };
  if (!(event.key in offsets)) return;
  event.preventDefault();
  scrollTo(offsets[event.key]!);
}

function onWheel(event: WheelEvent) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height.value : 1;
  scrollTo(scrollTop.value + event.deltaY * unit);
}

watch([() => props.target, track], ([target], _, onCleanup) => {
  if (!target) return;
  const resize = new ResizeObserver(measure);
  function observe() {
    resize.disconnect();
    resize.observe(target!);
    if (track.value) resize.observe(track.value);
    for (const child of target!.children) resize.observe(child);
    measure();
  }
  const mutation = new MutationObserver(observe);
  mutation.observe(target, { childList: true, subtree: true });
  target.addEventListener('scroll', measure, { passive: true });
  observe();
  onCleanup(() => {
    resize.disconnect();
    mutation.disconnect();
    target.removeEventListener('scroll', measure);
  });
}, { flush: 'post', immediate: true });
</script>

<template>
  <div
    v-show="maximum > 0"
    ref="track"
    class="overlay-scrollbar"
    :class="{ dragging }"
    role="scrollbar"
    tabindex="0"
    :aria-label="label"
    :aria-controls="target?.id"
    aria-orientation="vertical"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="percentage"
    @pointerdown.prevent="startDrag"
    @pointermove="dragTo"
    @pointerup="stopDrag"
    @pointercancel="stopDrag"
    @lostpointercapture="stopDrag"
    @keydown="onKeydown"
    @wheel.prevent="onWheel"
  >
    <div class="overlay-scrollbar-thumb" :style="{ height: `${thumbHeight}px`, transform: `translateY(${thumbTop}px)` }" />
  </div>
</template>

<style scoped>
.overlay-scrollbar {
  position: absolute;
  inset: 2px 1px 2px auto;
  width: 12px;
  z-index: 2;
  touch-action: none;
  user-select: none;
}
.overlay-scrollbar-thumb {
  width: 8px;
  margin-inline: auto;
  border: 1px solid #ffffffb3;
  border-radius: 999px;
  background: var(--scrollbar-thumb);
  box-shadow: 0 0 1px #0008;
}
.overlay-scrollbar:hover .overlay-scrollbar-thumb,
.overlay-scrollbar:focus-visible .overlay-scrollbar-thumb {
  background: var(--scrollbar-thumb-hover);
}
.overlay-scrollbar.dragging .overlay-scrollbar-thumb {
  background: var(--scrollbar-thumb-active);
}
.overlay-scrollbar:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: -1px;
  border-radius: 999px;
}
@media (forced-colors: active) {
  .overlay-scrollbar-thumb,
  .overlay-scrollbar:hover .overlay-scrollbar-thumb,
  .overlay-scrollbar:focus-visible .overlay-scrollbar-thumb,
  .overlay-scrollbar.dragging .overlay-scrollbar-thumb {
    background: CanvasText;
    border-color: Canvas;
    forced-color-adjust: none;
  }
}
</style>
