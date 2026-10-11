<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Live2DModelInfo } from '@pigeon-skin/shared/live2d';
import type { Application, Renderer } from 'pixi.js';
import type { Live2DModel } from 'pixi-live2d-display';
import { loadLive2DCore, motionVoice, selectTapMotion } from '@/lib/live2d';
import { useI18n } from '@/stores/i18n';
import { useLive2DVoice } from '@/composables/live2d-voice';
import Live2DToolbar from './Live2DToolbar.vue';

const props = withDefaults(defineProps<{ model: Live2DModelInfo; width?: number; height?: number; allowTransform?: boolean }>(), { width: 240, height: 320, allowTransform: false });
const emit = defineEmits<{ error: [error: unknown]; ready: [capabilities: { hasVoice: boolean }] }>();
const i18n = useI18n();
const voice = useLive2DVoice();
const canvas = ref<HTMLCanvasElement | null>(null);
const canvasKey = ref(0);
const voiceElement = ref<HTMLAudioElement | null>(null);
const hasVoice = ref(false);
const loading = ref(true);
const failed = ref(false);
const photoOpen = ref(false);
const photoUrl = ref<string | null>(null);
const photoName = ref('');
let app: Application | null = null;
let generation = 0;
let currentModel: Live2DModel | null = null;
let releaseCurrentTextures: (() => void) | null = null;
let playMotion: ((group: string, index: number) => Promise<boolean>) | null = null;
let audio: HTMLAudioElement | null = null;
let audioGeneration = 0;
const voiceFadeDuration = 180;
let interactionGeneration = 0;
let requestController: AbortController | null = null;
let initialTransform: { scale: number; x: number; y: number } | null = null;
let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
let dragged = false;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function failRendering(error: unknown) {
  if (failed.value) return;
  failed.value = true;
  loading.value = false;
  app?.stop();
  stopVoice();
  console.error('Live2D rendering failed', props.model.url, error);
  emit('error', error);
}

function validateTextures(model: Live2DModel, instance: Application, uploaded = false) {
  const renderer = instance.renderer as Renderer;
  const gl = renderer.gl;
  if (gl.isContextLost()) throw new Error('Live2D WebGL context was lost');
  if (!model.textures.length) throw new Error('Live2D model has no textures');
  for (const [index, texture] of model.textures.entries()) {
    if (!texture.valid || !texture.baseTexture?.valid || texture.baseTexture.destroyed) throw new Error(`Live2D texture ${index} is invalid`);
    if (uploaded) {
      const gpuTexture = texture.baseTexture._glTextures[renderer.CONTEXT_UID];
      if (!gpuTexture || !gl.isTexture(gpuTexture.texture)) throw new Error(`Live2D GPU texture ${index} is unavailable`);
    }
  }
}

function renderFrame() {
  if (!app || !currentModel || failed.value) return;
  try { validateTextures(currentModel, app); app.render(); validateTextures(currentModel, app, true); }
  catch (error) { failRendering(error); }
}

function contextLost(event: Event) {
  event.preventDefault();
  if (event.currentTarget === canvas.value && app && !loading.value) failRendering(new Error('Live2D WebGL context was lost'));
}

function disposeModel(model: Live2DModel | null) {
  if (!model || model.destroyed) return;
  if (model.internalModel) model.destroy({ texture: true, baseTexture: true });
  else model.emit('destroy');
}

function visibility() {
  if (document.hidden) stopVoice();
  if (document.hidden || reducedMotion.matches) app?.stop();
  else app?.start();
  renderFrame();
}

function fadeOutVoice(element: HTMLAudioElement): Promise<void> {
  const start = performance.now();
  const initialVolume = element.volume;
  return new Promise(resolve => {
    const step = () => {
      // rAF 回调的时间戳是帧起始时间，可能早于 start（首帧/高刷屏），负差值会让
      // 1-progress > 1 把 volume 推出 [0,1] 抛 IndexSizeError；这里自取当前时间并夹紧
      const progress = Math.min(1, Math.max(0, (performance.now() - start) / voiceFadeDuration));
      element.volume = initialVolume * (1 - progress);
      if (progress < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

function stopVoice() {
  audioGeneration++;
  const element = audio;
  audio = null;
  if (!element) return;
  element.ontimeupdate = null;
  element.onended = null;
  element.onerror = null;
  void fadeOutVoice(element).then(() => {
    element.pause();
    element.removeAttribute('src');
    element.load();
    element.volume = 1;
  });
}

async function performMotion(group: string) {
  const interactionId = ++interactionGeneration;
  const model = currentModel;
  if (!model || !playMotion) return;
  const manager = model.internalModel.motionManager;
  const definitions = manager.definitions[group];
  if (!definitions?.length) return;
  const index = Math.floor(Math.random() * definitions.length);
  const sound = motionVoice(definitions[index]);
  stopVoice();
  if (!voice.muted.value && sound) {
    audio = voiceElement.value;
    if (audio) {
      audio.src = manager.settings.resolveURL(sound);
      const playingAudio = audio;
      const audioId = ++audioGeneration;
      playingAudio.volume = 1;
      let fading = false;
      const finishVoice = () => {
        if (audioId !== audioGeneration || audio !== playingAudio) return;
        playingAudio.ontimeupdate = null;
        playingAudio.onended = null;
        playingAudio.onerror = null;
        playingAudio.volume = 1;
        audio = null;
      };
      const fadeTail = () => {
        if (fading || audioId !== audioGeneration || audio !== playingAudio) return;
        fading = true;
        void fadeOutVoice(playingAudio).then(() => {
          if (audioId === audioGeneration && audio === playingAudio) finishVoice();
        });
      };
      playingAudio.ontimeupdate = () => {
        if (Number.isFinite(playingAudio.duration) && playingAudio.duration - playingAudio.currentTime <= voiceFadeDuration / 1000) fadeTail();
      };
      playingAudio.onended = finishVoice;
      playingAudio.onerror = () => {
        // 音频文件损坏/解码失败（MediaError code 3）只会重复触发，清理监听并
        // 静默放弃本次语音，不刷控制台
        playingAudio.ontimeupdate = null;
        playingAudio.onended = null;
        playingAudio.onerror = null;
        if (audioId === audioGeneration && audio === playingAudio) audio = null;
      };
      void playingAudio.play().catch(error => {
        if (audioId === audioGeneration && error?.name !== 'AbortError') console.error('Live2D voice playback failed', playingAudio.src, error);
      });
    }
  }
  try {
    const played = await playMotion(group, index);
    if (!played && model === currentModel && interactionId === interactionGeneration) stopVoice();
  } catch (error) {
    if (model === currentModel && interactionId === interactionGeneration) { stopVoice(); console.error('Live2D interaction failed', props.model.url, error); }
  }
}

async function build() {
  const id = ++generation;
  requestController?.abort();
  stopVoice();
  const previousApp = app;
  app = null;
  previousApp?.destroy(false, { children: true, texture: true, baseTexture: true });
  releaseCurrentTextures?.();
  releaseCurrentTextures = null;
  app = null;
  currentModel = null;
  playMotion = null;
  initialTransform = null;
  drag = null;
  loading.value = true;
  failed.value = false;
  canvasKey.value++;
  await nextTick();
  if (id !== generation || !canvas.value) return;
  let pending: Live2DModel | null = null;
  let instance: Application | null = null;
  let releaseTextures: (() => void) | null = null;
  let controller: AbortController | null = null;
  try {
    await loadLive2DCore(props.model.version);
    const [PIXI, live2d] = await Promise.all([
      import('pixi.js'),
      props.model.version === 2 ? import('pixi-live2d-display/cubism2') : import('pixi-live2d-display/cubism4'),
    ]);
    if (id !== generation || !canvas.value) return;
    live2d.Live2DModel.registerTicker(PIXI.Ticker);
    live2d.config.sound = false;
    if (!PIXI.utils.isWebGLSupported()) throw new Error('WebGL is not supported');
    instance = new PIXI.Application({ view: canvas.value, width: props.width, height: props.height, backgroundAlpha: 0, antialias: true, autoStart: false, preserveDrawingBuffer: true, resolution: Math.min(devicePixelRatio, 2), autoDensity: true });
    app = instance;
    instance.ticker.maxFPS = 30;
    controller = new AbortController();
    requestController = controller;
    const response = await fetch(props.model.url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
    if (!response.ok) throw new Error(`Live2D model request failed: ${response.status}`);
    const source = await response.json();
    source.url = props.model.url;
    const texturePaths: unknown = props.model.version === 2 ? source.textures : source.FileReferences?.Textures;
    if (!Array.isArray(texturePaths) || !texturePaths.length || texturePaths.some(path => typeof path !== 'string' || !path)) throw new Error('Live2D texture references are invalid');
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    const textureBlobs = await Promise.all(texturePaths.map(async path => {
      const url = new URL(path, new URL(props.model.url, location.href));
      const textureResponse = await fetch(url, { signal });
      if (!textureResponse.ok) throw new Error(`Live2D texture request failed: ${textureResponse.status} ${url}`);
      const blob = await textureResponse.blob();
      if (!blob.size) throw new Error(`Live2D texture is empty: ${url}`);
      return blob;
    }));
    if (id !== generation) { if (instance.renderer) instance.destroy(false); return; }
    const textureUrls = textureBlobs.map(blob => URL.createObjectURL(blob));
    releaseTextures = () => {
      for (const url of textureUrls) {
        PIXI.utils.TextureCache[url]?.destroy(true);
        PIXI.utils.BaseTextureCache[url]?.destroy();
        URL.revokeObjectURL(url);
      }
    };
    if (props.model.version === 2) source.textures = textureUrls;
    else source.FileReferences.Textures = textureUrls;
    if (props.model.version === 2) source.layout = { width: 2, height: 2, center_x: 0, center_y: 0 };
    else source.Layout = {};
    const settings = props.model.version === 2 ? new live2d.Cubism2ModelSettings(source) : new live2d.Cubism4ModelSettings(source);
    settings.resolveURL = path => new URL(path, new URL(props.model.url, location.href)).href;
    await new Promise<void>((resolve, reject) => {
      pending = live2d.Live2DModel.fromSync(settings, { autoUpdate: false, autoInteract: false, motionPreload: live2d.MotionPreloadStrategy.IDLE, onLoad: resolve, onError: reject });
    });
    if (!pending) throw new Error('Live2D model did not initialize');
    const loadedModel: Live2DModel = pending;
    if (id !== generation) {
      disposeModel(loadedModel);
      if (instance.renderer) instance.destroy(false);
      releaseTextures();
      return;
    }
    validateTextures(loadedModel, instance);
    const scale = Math.min(props.width / loadedModel.width, props.height / loadedModel.height) * 0.95;
    loadedModel.scale.set(scale);
    loadedModel.anchor.set(0.5, 1);
    loadedModel.position.set(props.width / 2 - loadedModel.internalModel.localTransform.tx * scale, props.height - loadedModel.internalModel.localTransform.ty * scale);
    instance.stage.addChild(loadedModel);
    const model = loadedModel;
    playMotion = (group, index) => model.motion(group, index, live2d.MotionPriority.FORCE);
    const activeInstance = instance;
    instance.ticker.add(() => {
      if (failed.value) return;
      try { validateTextures(model, activeInstance, true); model.update(activeInstance.ticker.deltaMS); }
      catch (error) { failRendering(error); }
    });
    app = instance;
    currentModel = loadedModel;
    releaseCurrentTextures = releaseTextures;
    hasVoice.value = Object.values(loadedModel.internalModel.motionManager.definitions).some(definitions => definitions?.some(definition => !!motionVoice(definition)));
    initialTransform = { scale, x: loadedModel.x, y: loadedModel.y };
    loadedModel.update(0);
    visibility();
    if (failed.value) return;
    emit('ready', { hasVoice: hasVoice.value });
  } catch (error) {
    disposeModel(pending);
    if (instance?.renderer) instance.destroy(false);
    releaseTextures?.();
    controller?.abort();
    // 路由切换/重建触发的取消是预期行为（requestController 或 motion 队列 abort），
    // 只在"仍是当前挂载且非取消"时按失败上报，避免切换页面刷 AbortError
    const cancelled = id !== generation || (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError'));
    if (!cancelled) {
      app = null;
      failed.value = true;
      console.error('Live2D model failed to load', props.model.url, error);
      emit('error', error);
    }
  } finally {
    if (id === generation) loading.value = false;
  }
}

function focus(event: PointerEvent) {
  if (!currentModel || !canvas.value || reducedMotion.matches) return;
  const rect = canvas.value.getBoundingClientRect();
  currentModel.focus((event.clientX - rect.left) * props.width / rect.width, (event.clientY - rect.top) * props.height / rect.height);
}

function beginTransform(event: PointerEvent) {
  if (!props.allowTransform || !currentModel || event.button !== 0) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: currentModel.x, top: currentModel.y };
  dragged = false;
}
function pointerMove(event: PointerEvent) {
  if (drag && currentModel && drag.id === event.pointerId) {
    const rect = canvas.value!.getBoundingClientRect();
    const dx = (event.clientX - drag.x) * props.width / rect.width;
    const dy = (event.clientY - drag.y) * props.height / rect.height;
    if (Math.hypot(dx, dy) > 4) dragged = true;
    if (dragged) {
      canvas.value!.setPointerCapture(event.pointerId);
      currentModel.position.set(drag.left + dx, drag.top + dy);
      renderFrame();
      return;
    }
  }
  focus(event);
}
function endTransform(event: PointerEvent) {
  if (drag?.id !== event.pointerId) return;
  drag = null;
  if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId);
}
function zoom(delta: number) {
  if (!currentModel || !initialTransform) return;
  const scale = Math.max(initialTransform.scale * 0.4, Math.min(initialTransform.scale * 3, currentModel.scale.x + initialTransform.scale * delta));
  currentModel.scale.set(scale);
  renderFrame();
}
function wheel(event: WheelEvent) {
  if (!props.allowTransform) return;
  event.preventDefault();
  zoom(event.deltaY > 0 ? -0.1 : 0.1);
}
function reset() {
  if (!currentModel || !initialTransform) return;
  currentModel.scale.set(initialTransform.scale);
  currentModel.position.set(initialTransform.x, initialTransform.y);
  renderFrame();
}

async function interact(event: MouseEvent | KeyboardEvent) {
  if (event instanceof MouseEvent && dragged) { dragged = false; return; }
  const model = currentModel;
  if (!model || loading.value || failed.value) return;
  const rect = canvas.value!.getBoundingClientRect();
  const x = event instanceof MouseEvent ? (event.clientX - rect.left) * props.width / rect.width : props.width / 2;
  const y = event instanceof MouseEvent ? (event.clientY - rect.top) * props.height / rect.height : props.height / 2;
  const areas = model.hitTest(x, y);
  if (!areas.length) return;
  const manager = model.internalModel.motionManager;
  const groups = Object.keys(manager.definitions).filter(group => manager.definitions[group]?.length);
  const group = selectTapMotion(areas, groups, manager.groups.idle);
  try {
    if (group && playMotion) await performMotion(group);
    else if (manager.expressionManager) await model.expression();
    else if (groups.includes(manager.groups.idle) && playMotion) await performMotion(manager.groups.idle);
  } catch (error) {
    if (model === currentModel) console.error('Live2D interaction failed', props.model.url, error);
  }
  if (model === currentModel) { model.update(1); renderFrame(); }
}

async function action() {
  const model = currentModel;
  if (!model) return;
  const manager = model.internalModel.motionManager;
  const groups = Object.keys(manager.definitions).filter(group => manager.definitions[group]?.length);
  const group = selectTapMotion(['head', 'body'], groups, manager.groups.idle) || manager.groups.idle;
  if (groups.includes(group)) await performMotion(group);
  else if (manager.expressionManager) await model.expression();
}

function capture() {
  if (!canvas.value || loading.value || failed.value) return;
  try {
    renderFrame();
    if (failed.value) return;
    const filename = `${props.model.name.replace(/[\\/:*?"<>|]/g, '_')}.png`;
    const captureGeneration = generation;
    canvas.value.toBlob(blob => {
      if (captureGeneration !== generation) return;
      if (!blob) { console.error('Live2D capture did not produce an image'); return; }
      if (photoUrl.value) URL.revokeObjectURL(photoUrl.value);
      photoUrl.value = URL.createObjectURL(blob);
      photoName.value = filename;
      photoOpen.value = true;
    }, 'image/png');
  } catch (error) { console.error('Live2D capture failed', error); }
}
defineExpose({ action, capture, stopVoice });
watch(voice.muted, muted => { if (muted) stopVoice(); });
watch(photoOpen, open => {
  if (!open && photoUrl.value) { URL.revokeObjectURL(photoUrl.value); photoUrl.value = null; }
});

onMounted(() => { void build(); });
watch(() => [props.model.url, props.width, props.height], () => { void build(); }, { flush: 'post' });
document.addEventListener('visibilitychange', visibility);
reducedMotion.addEventListener('change', visibility);
onBeforeUnmount(() => {
  generation++;
  requestController?.abort();
  stopVoice();
  if (photoUrl.value) URL.revokeObjectURL(photoUrl.value);
  document.removeEventListener('visibilitychange', visibility);
  reducedMotion.removeEventListener('change', visibility);
  const retiringApp = app;
  const retiringCanvas = canvas.value;
  const releaseTextures = releaseCurrentTextures;
  releaseCurrentTextures = null;
  app = null;
  retiringApp?.stop();
  function release() {
    if (retiringCanvas?.isConnected) { window.setTimeout(release, 50); return; }
    retiringApp?.destroy(false, { children: true, texture: true, baseTexture: true });
    releaseTextures?.();
  }
  release();
});
</script>

<template>
  <div v-show="!failed" class="relative" :style="{ width: `${width}px`, height: `${height}px` }">
    <audio ref="voiceElement" preload="none" hidden />
    <canvas :key="canvasKey" ref="canvas" class="live2d-canvas" :class="{ ready: !loading }" :aria-label="i18n.t('live2d.character', { name: model.name })" role="img" tabindex="0" :style="allowTransform ? { cursor: 'grab', touchAction: 'none' } : undefined" @pointerdown="beginTransform" @pointermove="pointerMove" @pointerup="endTransform" @pointercancel="endTransform" @wheel="wheel" @click="interact" @keydown.enter.prevent="interact" @keydown.space.prevent="interact" @webglcontextlost="contextLost" />
    <Transition name="live2d-tools">
      <Live2DToolbar v-if="allowTransform && !loading" class="absolute right-0 top-12" :muted="voice.muted.value" :has-voice="hasVoice" @mute="voice.toggle" @action="action" @capture="capture" @zoom="zoom" @reset="reset" />
    </Transition>
    <div v-if="loading" class="absolute inset-0 flex items-center justify-center" role="status" :aria-label="i18n.t('common.loading')">
      <span class="material-icons animate-spin text-muted" aria-hidden="true">progress_activity</span>
    </div>
    <AppDialog v-if="photoUrl" v-model="photoOpen" :title="i18n.t('live2d.photo')">
      <div class="flex flex-col items-center gap-4">
        <img :src="photoUrl" :alt="model.name" class="max-h-96 max-w-full" />
        <a :href="photoUrl" :download="photoName" class="btn btn-primary">{{ i18n.t('live2d.download_photo') }}</a>
      </div>
    </AppDialog>
  </div>
</template>

<style scoped>
.live2d-canvas { opacity: 0; transition: opacity 0.6s ease; }
.live2d-canvas.ready { opacity: 1; }
.live2d-model-enter-active, .live2d-model-leave-active { transition: opacity 0.35s ease, transform 0.35s ease; }
.live2d-model-enter-from, .live2d-model-leave-to { opacity: 0; transform: translateY(12px); }
.live2d-tools-enter-active, .live2d-tools-leave-active { transition: opacity 0.4s ease; }
.live2d-tools-enter-from, .live2d-tools-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .live2d-canvas, .live2d-model-enter-active, .live2d-model-leave-active, .live2d-tools-enter-active, .live2d-tools-leave-active { transition: none; }
}
</style>
