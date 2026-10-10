<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from '@/stores/i18n';
import { useTheme } from '@/composables/theme';
import SkinPreview from '@/components/SkinPreview.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { defaultSkinUrl } from '@/lib/default-skin';
const props = withDefaults(defineProps<{
  skinUrl?: string | null | undefined; capeUrl?: string | null | undefined; slim?: boolean;
  height?: number; animated?: boolean; controls?: boolean; active?: boolean; name?: string;
}>(), { slim: false, height: 380, animated: true, controls: true, active: true, name: '' });
const i18n = useI18n();
const { isDark } = useTheme();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const resizePreview = ref<string | null>(null);
const failed = ref(false), loading = ref(true), saving = ref(false);
const backgroundLoading = ref(false), backgroundError = ref(false), captureError = ref(false);
const equipment = ref<'cape' | 'elytra'>('cape');
const paused = ref(!props.animated), rotating = ref(props.animated);
const animationIndex = ref(0);
const background = ref<'transparent' | 'white' | 'gray' | 'black' | 'picture'>('transparent');
const pictureIndex = ref(-1);
const colors = { transparent: null, white: '#ffffff', gray: '#6c757d', black: '#000000' } as const;
const contents = computed(() => i18n.t(props.skinUrl && props.capeUrl ? 'skinlib.skin_and_cape' : props.capeUrl ? 'general.cape' : 'general.skin'));
let animations: Array<() => import('skinview3d').PlayerAnimation> = [];
let viewer: import('skinview3d').SkinViewer | null = null;
let resetCamera: (() => void) | null = null;
let generation = 0, backgroundGeneration = 0;
let observer: ResizeObserver | null = null;
let resizeFrame = 0;
let resizePreviewFrame = 0;
let resizePreviewGeneration = 0;
let lastResize = '';
function resizeViewer(width: number, height: number) {
  const current = viewer, canvas = canvasRef.value;
  if (!current || !canvas) return;
  lastResize = `${width}:${height}`;
  const token = ++resizePreviewGeneration;
  if (resizePreviewFrame) cancelAnimationFrame(resizePreviewFrame);
  try { if (!loading.value && !failed.value) resizePreview.value = canvas.toDataURL('image/png'); }
  catch { resizePreview.value = null; }
  current.setSize(width, height);
  current.render();
  resizePreviewFrame = requestAnimationFrame(() => {
    if (token !== resizePreviewGeneration || current !== viewer) return;
    current.render();
    resizePreviewFrame = requestAnimationFrame(() => {
      if (token === resizePreviewGeneration) resizePreview.value = null;
      resizePreviewFrame = 0;
    });
  });
}
function applyThemeLighting() {
  if (!viewer) return;
  viewer.cameraLight.intensity = isDark.value ? 0 : 0.6;
  viewer.globalLight.intensity = 3;
}
async function build() {
  const id = ++generation;
  backgroundGeneration++;
  viewer?.dispose(); viewer = null; resetCamera = null;
  failed.value = false; loading.value = true; captureError.value = false;
  await nextTick();
  const canvas = canvasRef.value;
  if (!canvas) return;
  let v: import('skinview3d').SkinViewer | null = null;
  try {
    const skinview3d = await import('skinview3d');
    if (id !== generation) return;
    const initialWidth = containerRef.value?.clientWidth || canvas.clientWidth || props.height;
    v = new skinview3d.SkinViewer({ canvas, width: initialWidth, height: props.height, preserveDrawingBuffer: true, enableControls: props.controls });
    v.fov = 50; v.zoom = 0.9;
    v.cameraLight.intensity = isDark.value ? 0 : 0.6;
    v.globalLight.intensity = 3;
    await v.loadSkin(props.skinUrl || defaultSkinUrl, { model: props.skinUrl && props.slim ? 'slim' : 'default' });
    if (props.capeUrl) await v.loadCape(props.capeUrl, { backEquipment: equipment.value });
    if (id !== generation) { v.dispose(); return; }
    animations = [
      () => new skinview3d.WalkingAnimation(), () => new skinview3d.RunningAnimation(),
      () => new skinview3d.FlyingAnimation(), () => new skinview3d.IdleAnimation(),
    ];
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { paused.value = true; rotating.value = false; }
    v.animation = animations[animationIndex.value]!();
    if (props.capeUrl && !props.skinUrl) v.playerWrapper.rotation.y = Math.PI + Math.PI / 8;
    const builtViewer = v;
    const position = v.camera.position.clone(), orientation = v.camera.quaternion.clone(), target = v.controls.target.clone();
    const rotation = v.playerWrapper.rotation.y;
    resetCamera = () => {
      builtViewer.zoom = 0.9;
      builtViewer.camera.position.copy(position); builtViewer.camera.quaternion.copy(orientation);
      builtViewer.controls.target.copy(target); builtViewer.playerWrapper.rotation.y = rotation;
      builtViewer.controls.update();
    };
    viewer = v; applyMotion(); viewer.renderPaused = !props.active;
    const width = containerRef.value?.clientWidth || initialWidth;
    if (width !== initialWidth) v.setSize(width, props.height);
    lastResize = `${width}:${props.height}`;
    v.render();
    void applyBackground();
  } catch { v?.dispose(); if (id === generation) failed.value = true; }
  finally { if (id === generation) loading.value = false; }
}
async function applyBackground() {
  const current = viewer, id = ++backgroundGeneration;
  backgroundError.value = false; backgroundLoading.value = false;
  if (!current) return;
  if (background.value !== 'picture') { current.background = colors[background.value]; return; }
  backgroundLoading.value = true;
  try {
    const image = new Image(); image.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('Background unavailable'));
      image.src = '/assets/preview-backgrounds/' + (pictureIndex.value + 1) + '.svg';
    });
    if (id === backgroundGeneration && current === viewer) current.loadBackground(image);
  } catch { if (id === backgroundGeneration) backgroundError.value = true; }
  finally { if (id === backgroundGeneration) backgroundLoading.value = false; }
}
function setBackground(value: keyof typeof colors) { background.value = value; void applyBackground(); }
function changePicture(direction: number) {
  pictureIndex.value = ((pictureIndex.value < 0 ? (direction > 0 ? -1 : 0) : pictureIndex.value) + direction + 7) % 7;
  background.value = 'picture'; void applyBackground();
}
function applyMotion() {
  if (!viewer) return;
  if (viewer.animation) viewer.animation.paused = paused.value;
  viewer.autoRotate = rotating.value;
}
function togglePlayback() { paused.value = !paused.value; if (paused.value) rotating.value = false; applyMotion(); }
function toggleRotation() { rotating.value = !rotating.value; applyMotion(); }
function switchAnimation() {
  if (!viewer) return;
  viewer.animation = animations[animationIndex.value]!(); paused.value = false; applyMotion();
}
function toggleEquipment() {
  equipment.value = equipment.value === 'cape' ? 'elytra' : 'cape';
  if (viewer) viewer.playerObject.backEquipment = equipment.value;
}
function zoom(direction: number) {
  if (viewer) viewer.zoom = Math.min(2, Math.max(0.4, viewer.zoom + direction * 0.1));
}
async function capture(): Promise<Blob | null> {
  const current = viewer;
  if (!current || failed.value || loading.value) return null;
  current.render();
  return new Promise(resolve => current.canvas.toBlob(resolve, 'image/png'));
}
async function downloadCapture() {
  saving.value = true; captureError.value = false;
  try {
    const blob = await capture();
    if (!blob) throw new Error('Capture unavailable');
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = (props.name || i18n.t('general.texturePreview')) + '.png';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { captureError.value = true; }
  finally { saving.value = false; }
}
onMounted(() => {
  void build();
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const width = containerRef.value?.clientWidth;
      const key = `${width || 0}:${props.height}`;
      if (viewer && width && key !== lastResize) {
        lastResize = key;
        resizeViewer(width, props.height);
      }
    });
  });
  if (containerRef.value) observer.observe(containerRef.value);
});
watch(() => [props.skinUrl, props.capeUrl, props.slim], () => void build());
watch(() => props.height, height => { if (viewer && canvasRef.value?.clientWidth) resizeViewer(canvasRef.value.clientWidth, height); });
watch(() => props.animated, animated => { paused.value = !animated; rotating.value = animated; applyMotion(); });
watch(() => props.active, async active => {
  await nextTick();
  if (!viewer) return;
  if (active && canvasRef.value?.clientWidth) resizeViewer(canvasRef.value.clientWidth, props.height);
  viewer.renderPaused = !active;
});
watch(isDark, applyThemeLighting);
onBeforeUnmount(() => { generation++; backgroundGeneration++; resizePreviewGeneration++; observer?.disconnect(); cancelAnimationFrame(resizeFrame); cancelAnimationFrame(resizePreviewFrame); viewer?.dispose(); });
defineExpose({ capture });
</script>
<template>
  <div class="w-full">
    <div v-if="controls" class="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
      <span class="badge">{{ contents }}</span>
      <div class="flex flex-wrap items-center gap-1">
        <AppSelect v-model="animationIndex" class="!w-auto !min-h-8 !py-1 !text-xs" :options="['walk', 'run', 'fly', 'idle'].map((name, index) => ({ value: index, label: i18n.t('skinlib.animation_' + name) }))" :disabled="loading || failed" :aria-label="i18n.t('skinlib.switch_animation')" @change="switchAnimation" />
        <AppButton v-if="capeUrl" class="btn-icon !h-8 !w-8" :disabled="loading || failed" :aria-label="i18n.t('skinlib.switch_equipment')" :aria-pressed="equipment === 'elytra'" @click="toggleEquipment"><AppIcon name="checkroom" /></AppButton>
        <AppButton class="btn-icon !h-8 !w-8" :disabled="loading || failed" :aria-label="i18n.t(paused ? 'skinlib.play_animation' : 'skinlib.pause_animation')" :aria-pressed="!paused" @click="togglePlayback"><AppIcon :name="paused ? 'play_arrow' : 'pause'" /></AppButton>
        <AppButton class="btn-icon !h-8 !w-8" :disabled="loading || failed" :aria-label="i18n.t('skinlib.rotation')" :aria-pressed="rotating" @click="toggleRotation"><AppIcon name="rotate_right" /></AppButton>
      </div>
    </div>
    <div ref="containerRef" class="relative w-full" :class="controls ? 'bg-surface-2' : ''" :style="{ height: height + 'px' }">
      <canvas v-show="!failed && !loading && !resizePreview" ref="canvasRef" class="block h-full w-full" :class="{ 'pointer-events-none': !controls }" :aria-label="i18n.t('skinlib.preview_label')" />
      <img v-if="resizePreview && !loading" :src="resizePreview" class="pointer-events-none absolute inset-0 block h-full w-full object-contain" alt="" aria-hidden="true" />
      <div v-if="loading" class="absolute inset-0 skeleton" role="status" :aria-label="i18n.t('common.loading')" />
      <div v-if="failed" class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4">
        <div class="flex h-4/5 w-full items-center justify-center gap-3">
          <SkinPreview v-if="skinUrl" :skin-url="skinUrl" :slim="slim" :alt="i18n.t('general.skin')" class="max-h-full max-w-[70%] object-contain" />
          <SkinPreview v-if="capeUrl" :skin-url="capeUrl" cape :alt="i18n.t('general.cape')" class="max-h-full max-w-[45%] object-contain" />
        </div>
        <p class="text-xs text-muted">{{ i18n.t('skinlib.preview_failed') }}</p>
        <AppButton class="btn-sm" @click="build">{{ i18n.t('common.retry') }}</AppButton>
      </div>
    </div>
    <div v-if="controls" class="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-3 py-2">
      <div class="flex flex-wrap items-center gap-1">
        <AppButton v-for="color in ['transparent', 'white', 'gray', 'black'] as const" :key="color" class="btn-icon btn-sm" :disabled="loading || failed" :aria-label="i18n.t('skinlib.background_' + color)" :aria-pressed="background === color" @click="setBackground(color)">
          <span class="h-4 w-4 rounded-sm border border-line" :style="{ background: colors[color] || 'repeating-conic-gradient(#b8bdc5 0% 25%, #fff 0% 50%) 50% / 8px 8px' }" />
        </AppButton>
        <AppButton class="btn-icon btn-sm" :disabled="loading || failed" :aria-label="i18n.t('skinlib.background_previous')" @click="changePicture(-1)"><AppIcon name="chevron_left" /></AppButton>
        <span v-if="background === 'picture'" class="text-xs tabular-nums text-muted" role="status">{{ i18n.t('skinlib.background_count', { current: i18n.n(pictureIndex + 1), total: i18n.n(7) }) }}</span>
        <AppButton class="btn-icon btn-sm" :disabled="loading || failed" :aria-label="i18n.t('skinlib.background_next')" @click="changePicture(1)"><AppIcon name="chevron_right" /></AppButton>
        <AppIcon v-if="backgroundLoading" name="sync" class="animate-spin !text-sm" :aria-label="i18n.t('common.loading')" />
      </div>
      <div class="flex items-center gap-1">
        <AppButton class="btn-icon btn-sm" :disabled="loading || failed" :aria-label="i18n.t('skinlib.zoom_out')" @click="zoom(-1)"><AppIcon name="zoom_out" /></AppButton>
        <AppButton class="btn-icon btn-sm" :disabled="loading || failed" :aria-label="i18n.t('skinlib.zoom_in')" @click="zoom(1)"><AppIcon name="zoom_in" /></AppButton>
        <AppButton class="btn-icon btn-sm" :disabled="loading || failed" :aria-label="i18n.t('skinlib.reset_view')" @click="resetCamera?.()"><AppIcon name="center_focus_strong" /></AppButton>
        <AppButton class="btn-icon btn-sm" :disabled="loading || failed || backgroundLoading" :loading="saving" :aria-label="i18n.t('skinlib.capture')" @click="downloadCapture"><AppIcon name="photo_camera" /></AppButton>
      </div>
    </div>
    <p v-if="backgroundError" class="flex items-center gap-2 px-3 py-2 text-xs text-danger" role="alert">{{ i18n.t('skinlib.background_failed') }}<AppButton class="btn-sm" @click="applyBackground">{{ i18n.t('common.retry') }}</AppButton></p>
    <p v-if="captureError" class="px-3 py-2 text-xs text-danger" role="alert">{{ i18n.t('skinlib.capture_failed') }}</p>
  </div>
</template>
