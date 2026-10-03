<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Live2DDisplay } from '@pigeon-skin/shared/live2d';
import { live2dApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import Live2DCanvas from './Live2DCanvas.vue';
import Live2DToolbar from './Live2DToolbar.vue';
import { useLive2DVoice } from '@/composables/live2d-voice';
import { useSessionStore } from '@/stores/session';
import { useRouter } from 'vue-router';

const i18n = useI18n();
const session = useSessionStore();
const router = useRouter();
const voice = useLive2DVoice();
const modelCanvas = ref<InstanceType<typeof Live2DCanvas> | null>(null);
const ready = ref(false);
const hasVoice = ref(false);
const hidden = ref(false);
const desktopQuery = matchMedia('(min-width: 1024px)');
const desktop = ref(desktopQuery.matches);
const display = ref<Live2DDisplay | null>(null);
const failedModel = ref('');
const scale = ref(1);
const x = ref(0);
const y = ref(0);
const dragging = ref(false);
const width = 240;
const height = 320;
const edge = 12;
const storageKey = 'live2d-layout';
let active = true;
let inflight = false;
let gesture: { id: number; x: number; y: number; left: number; top: number } | null = null;
let moved = false;
const position = computed(() => ({ left: `${x.value}px`, top: `${y.value}px`, width: `${width * scale.value}px`, height: `${height * scale.value}px` }));

function viewportWidth() { return Math.min(document.documentElement.clientWidth, innerWidth - 16); }

function clamp() {
  const availableWidth = viewportWidth();
  const availableHeight = document.documentElement.clientHeight;
  const maximum = Math.min(2, (availableWidth - edge * 2) / width, (availableHeight - edge * 2) / height);
  scale.value = Math.min(scale.value, maximum);
  x.value = Math.max(edge, Math.min(x.value, availableWidth - width * scale.value - edge));
  y.value = Math.max(edge, Math.min(y.value, availableHeight - height * scale.value - edge));
}
function remember() {
  try { localStorage.setItem(storageKey, JSON.stringify({ x: x.value, y: y.value, scale: scale.value })); } catch { }
}
function hide() {
  modelCanvas.value?.stopVoice();
  hidden.value = true;
  try { localStorage.setItem('live2d-hidden', 'true'); } catch { }
}
function restore() {
  hidden.value = false;
  ready.value = false;
  try { localStorage.removeItem('live2d-hidden'); } catch { }
}
function reset() {
  scale.value = 1;
  x.value = viewportWidth() - width * scale.value - edge;
  y.value = document.documentElement.clientHeight - height * scale.value - edge;
  clamp(); remember();
}
function zoom(delta: number) {
  const bottom = y.value + height * scale.value;
  const center = x.value + width * scale.value / 2;
  const maximum = Math.min(2, (viewportWidth() - edge * 2) / width, (document.documentElement.clientHeight - edge * 2) / height);
  scale.value = Math.max(0.4, Math.min(maximum, scale.value + delta));
  x.value = center - width * scale.value / 2;
  y.value = bottom - height * scale.value;
  clamp(); remember();
}
function start(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, left: x.value, top: y.value };
  moved = false;
}
function move(event: PointerEvent) {
  if (!gesture || gesture.id !== event.pointerId) return;
  const dx = event.clientX - gesture.x;
  const dy = event.clientY - gesture.y;
  if (Math.hypot(dx, dy) > 4) moved = true;
  if (!moved) return;
  if (!dragging.value) (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = true;
  x.value = gesture.left + dx;
  y.value = gesture.top + dy;
  clamp();
}
function end(event: PointerEvent) {
  if (!gesture || gesture.id !== event.pointerId) return;
  gesture = null;
  dragging.value = false;
  const element = event.currentTarget as HTMLElement;
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  remember();
}
function click(event: MouseEvent) {
  if (moved) { event.preventDefault(); event.stopPropagation(); moved = false; }
}
function wheel(event: WheelEvent) { event.preventDefault(); zoom(event.deltaY > 0 ? -0.1 : 0.1); }
function keyboard(event: KeyboardEvent) {
  if ((event.target as HTMLElement).tagName !== 'CANVAS') return;
  const offsets: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
  const offset = offsets[event.key];
  if (!offset) return;
  event.preventDefault();
  x.value += offset[0]; y.value += offset[1]; clamp(); remember();
}

async function refresh() {
  if (inflight || document.hidden || !desktop.value) return;
  inflight = true;
  try {
    const result = await live2dApi.display();
    if (active) {
      if (display.value?.modelId !== result.modelId || display.value.enabled !== result.enabled) { failedModel.value = ''; ready.value = false; }
      display.value = result;
      // 功能关闭后停止 60s 空转轮询。唤醒路径：保存设置的那个窗口由
      // live2d-updated 事件立即唤醒；其它窗口在切回前台（visibilitychange）
      // 或跨过桌面断点时刷新。
      if (result.enabled) startPolling(); else stopPolling();
    }
  } catch (error) {
    if (active) { display.value = null; console.error('Live2D display settings failed to load', error); }
  } finally { inflight = false; }
}
let poll: number | undefined;
function startPolling() { poll ??= window.setInterval(() => { void refresh(); }, 60000); }
function stopPolling() { if (poll !== undefined) { window.clearInterval(poll); poll = undefined; } }
startPolling();
const visibility = () => { if (!document.hidden) void refresh(); };
const screenChanged = () => {
  desktop.value = desktopQuery.matches;
  if (desktop.value) void refresh();
  else { modelCanvas.value?.stopVoice(); ready.value = false; }
};
onMounted(() => {
  x.value = viewportWidth() - width * scale.value - edge;
  y.value = document.documentElement.clientHeight - height * scale.value - edge;
  try {
    hidden.value = localStorage.getItem('live2d-hidden') === 'true';
    const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (stored && [stored.x, stored.y, stored.scale].every(Number.isFinite) && stored.scale >= 0.4 && stored.scale <= 2) {
      x.value = stored.x; y.value = stored.y; scale.value = stored.scale;
    }
  } catch { }
  clamp(); void refresh();
});
window.addEventListener('resize', clamp);
desktopQuery.addEventListener('change', screenChanged);
window.addEventListener('live2d-updated', refresh);
document.addEventListener('visibilitychange', visibility);
onBeforeUnmount(() => {
  active = false;
  stopPolling();
  window.removeEventListener('resize', clamp);
  desktopQuery.removeEventListener('change', screenChanged);
  window.removeEventListener('live2d-updated', refresh);
  document.removeEventListener('visibilitychange', visibility);
});
</script>

<template>
  <Transition name="live2d-widget">
  <aside v-if="desktop && display?.enabled && display.model && failedModel !== display.model.id && !hidden" class="live2d-widget" :class="{ dragging }" :style="position" :aria-label="i18n.t('live2d.title')" @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @click.capture="click" @wheel="wheel" @keydown="keyboard">
    <div class="live2d-character" :style="{ transform: `scale(${scale})` }">
      <Transition name="live2d-model" mode="out-in" @before-leave="ready = false; modelCanvas?.stopVoice()">
      <Live2DCanvas :key="display.model.id" ref="modelCanvas" :model="display.model" :width="width" :height="height" @ready="ready = true; hasVoice = $event.hasVoice" @error="failedModel = display.model.id" />
      </Transition>
      <Live2DToolbar v-if="ready" class="live2d-tools" :muted="voice.muted.value" :has-voice="hasVoice" closeable :can-manage="session.isAdmin.value" @action="modelCanvas?.action()" @mute="voice.toggle" @capture="modelCanvas?.capture()" @zoom="zoom" @reset="reset" @hide="hide" @manage="router.push('/admin/live2d')" />
    </div>
  </aside>
  </Transition>
  <Transition name="live2d-widget">
    <button v-if="desktop && display?.enabled && display.model && failedModel !== display.model.id && hidden" class="live2d-restore" type="button" :aria-label="i18n.t('live2d.restore')" @click="restore"><AppIcon name="face" /></button>
  </Transition>
</template>

<style scoped>
.live2d-widget { position: fixed; z-index: 45; pointer-events: none; touch-action: none; }
.live2d-character { position: relative; width: 240px; height: 320px; transform-origin: top left; }
.live2d-character :deep(canvas) { pointer-events: auto; cursor: grab; touch-action: none; }
.dragging .live2d-character :deep(canvas) { cursor: grabbing; }
.live2d-widget :deep(button) { pointer-events: auto; }
.live2d-tools { position: absolute; top: 42px; right: 2px; opacity: 0; visibility: hidden; transition: opacity 0.65s, visibility 0.65s; pointer-events: auto; }
.live2d-widget:hover .live2d-tools, .live2d-widget:focus-within .live2d-tools { opacity: 1; visibility: visible; }
.live2d-restore { position: fixed; right: 12px; bottom: 64px; z-index: 45; display: grid; place-items: center; width: 42px; height: 38px; border: 1px solid var(--v0-border); border-radius: 8px; background: var(--v0-surface); color: var(--brand); cursor: pointer; box-shadow: 0 2px 10px color-mix(in srgb, var(--ink) 12%, transparent); }
.live2d-restore:hover { background: var(--brand-soft); }
.live2d-widget-enter-active, .live2d-widget-leave-active { transition: opacity 0.4s, transform 0.4s; }
.live2d-widget-enter-from, .live2d-widget-leave-to { opacity: 0; transform: translateY(18px); }
.live2d-widget-leave-active :deep(canvas), .live2d-widget-leave-active :deep(button) { pointer-events: none; }
@media (max-width: 1023px) { .live2d-widget, .live2d-restore { display: none !important; } }
@media (hover: none) { .live2d-tools { opacity: 1; visibility: visible; } }
@media (prefers-reduced-motion: reduce) { .live2d-tools, .live2d-widget-enter-active, .live2d-widget-leave-active { transition: none; } }
</style>
