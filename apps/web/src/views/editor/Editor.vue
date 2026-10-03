<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, textureApi } from '@/api';
import { isFrameMessage, type EditorKind } from '@/editor/bridge';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { confirmAction } from '@/stores/dialog';
import { apiErrorMessage } from '@/lib/api-error';

const route = useRoute();
const router = useRouter();
const i18n = useI18n();
const session = useSessionStore();
const frame = ref<HTMLIFrameElement | null>(null);
const error = ref('');
const busy = ref(false);
const dirty = ref(false);
const textureId = Number(route.query.texture) || 0;
const isDraft = route.query.draft === '1';
const kind = computed<EditorKind>(() => route.params.kind === 'cape' ? 'cape' : 'skin');
const model = ref<'default' | 'slim'>(route.query.model === 'slim' ? 'slim' : 'default');
const initialName = ref(String(route.query.name || i18n.t(kind.value === 'cape' ? 'editor.default_cape_name' : 'editor.default_skin_name')));
const blank = route.query.blank === '1' || (!textureId && !isDraft);
const initialized = ref(false);
const saveDialog = ref(false);
const pendingBlob = ref<Blob | null>(null);
const canOverwrite = ref(false);
let frameLoadTimer = 0;
const blockbenchLanguage = (() => {
  const locale = document.documentElement.lang.toLowerCase();
  return locale.startsWith('zh-tw') ? 'zh-tw' : locale.startsWith('zh') ? 'zh-cn' : locale.split('-')[0] || 'en';
})();

async function initialize() {
  if (!frame.value?.contentWindow || initialized.value) return;
  initialized.value = true;
  window.clearTimeout(frameLoadTimer);
  try {
    let image: Blob | null = null;
    let ownerId: number | null = null;
    if (isDraft) {
      const draft = JSON.parse(sessionStorage.getItem('editor-draft') || 'null') as { dataUrl?: string; name?: string } | null;
      if (!draft?.dataUrl) throw new Error(i18n.t('editor.draft_missing'));
      const response = await fetch(draft.dataUrl);
      image = await response.blob();
      if (draft.name) initialName.value = draft.name;
    } else if (!blank) {
      const metadata = await textureApi.get(textureId);
      if (metadata.kind !== kind.value) throw new Error(i18n.t('editor.wrong_kind'));
      model.value = metadata.model === 'slim' ? 'slim' : 'default';
      initialName.value = metadata.name;
      ownerId = metadata.uploaderId;
      canOverwrite.value = !!session.user.value && (metadata.uploaderId === session.user.value.id || session.isAdmin.value) && !metadata.official;
      image = await textureApi.content(textureId);
    }
    frame.value.contentWindow.postMessage({ type: 'editor:init', kind: kind.value, model: model.value, name: initialName.value, image, ...(textureId ? { resourceId: textureId, ownerId, editable: canOverwrite.value } : {}) }, location.origin);
  } catch (e) {
    error.value = e instanceof ApiError ? i18n.t(e.code) : e instanceof Error ? e.message : i18n.t('common.internal_error');
  }
}

function onFrameLoad() {
  window.clearTimeout(frameLoadTimer);
  frameLoadTimer = window.setTimeout(() => {
    if (!initialized.value && !error.value) error.value = i18n.t('editor.load_timeout');
  }, 15000);
}


async function onMessage(event: MessageEvent) {
  if (event.origin !== location.origin || event.source !== frame.value?.contentWindow || !isFrameMessage(event.data)) return;
  const message = event.data;
  if (message.type === 'editor:ready') { await initialize(); return; }
  if (message.type === 'editor:change') { dirty.value = message.dirty; if (message.model) model.value = message.model; return; }
  if (message.type === 'editor:error') { error.value = message.message; return; }
  if (message.type === 'editor:export') { downloadBlob(message.image); return; }
  if (message.type !== 'editor:save') return;
  if (textureId) {
    pendingBlob.value = message.image;
    if (canOverwrite.value) saveDialog.value = true;
    else await saveAs(message.image);
    return;
  }
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await saveAs(message.image);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally { busy.value = false; }
}

async function saveAs(blob: Blob) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const draft = isDraft ? JSON.parse(sessionStorage.getItem('editor-draft') || 'null') as Record<string, unknown> | null : null;
  const resourceName = textureId ? i18n.t('editor.copy_name', { name: initialName.value }) : initialName.value;
  sessionStorage.setItem('editor-result', JSON.stringify({ dataUrl, kind: kind.value, model: model.value, name: resourceName, sourceResourceId: textureId || (typeof draft?.sourceResourceId === 'number' ? draft.sourceResourceId : null), form: draft }));
  dirty.value = false;
  await router.push(`/skinlib/upload?editor=1&kind=${kind.value}&model=${model.value}`);
}

async function overwrite() {
  if (!pendingBlob.value || !textureId || busy.value) return;
  busy.value = true;
  saveDialog.value = false;
  try {
    await textureApi.replaceContent(textureId, pendingBlob.value);
    dirty.value = false;
    await router.push(`/skinlib/${textureId}`);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally { busy.value = false; pendingBlob.value = null; }
}

async function goBack() {
  if (dirty.value && !(await confirmAction(i18n.t('editor.unsaved_leave')))) return;
  if (textureId) void router.push(`/skinlib/${textureId}`);
  else if (isDraft) void router.push('/skinlib/upload?restore=1');
  else void router.push('/skinlib');
}
function frameCommand(command: 'save' | 'export') {
  frame.value?.contentWindow?.postMessage({ type: 'editor:command', command }, location.origin);
}
function downloadBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${initialName.value || kind.value}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(async () => { await session.fetchSession(); addEventListener('message', onMessage); });
onBeforeUnmount(() => { removeEventListener('message', onMessage); window.clearTimeout(frameLoadTimer); });
</script>

<template>
  <div class="fixed inset-0 z-[100] flex flex-col bg-surface">
    <header class="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
      <div class="flex items-center gap-3"><button class="btn btn-sm" @click="goBack">{{ i18n.t('general.back') }}</button><span class="font-medium">{{ initialName }}</span><span v-if="dirty" class="text-xs text-muted">{{ i18n.t('editor.unsaved') }}</span></div>
      <div class="flex items-center gap-2"><span v-if="busy" class="text-sm text-muted">{{ i18n.t('editor.saving') }}</span><button class="btn btn-primary btn-sm" :disabled="busy" @click="frameCommand('save')">{{ i18n.t('common.save') }}</button></div>
    </header>
    <p v-if="error" class="alert alert-danger m-2">{{ error }}</p>
    <iframe ref="frame" :title="i18n.t('editor.frame_title')" :src="`/blockbench/index.html?editor=1&site_lang=${blockbenchLanguage}`" class="min-h-0 w-full flex-1 border-0" @load="onFrameLoad" />
    <div v-if="saveDialog" class="absolute inset-0 z-[120] flex items-center justify-center bg-slate-950/70 p-6">
      <section class="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <h2 class="text-lg font-semibold">{{ i18n.t('editor.save_title') }}</h2>
        <p class="mt-2 text-sm text-muted">{{ i18n.t('editor.save_hint') }}</p>
        <div class="mt-5 grid gap-2"><button class="btn btn-primary" @click="overwrite">{{ i18n.t('editor.overwrite') }}</button><button class="btn" @click="pendingBlob && saveAs(pendingBlob)">{{ i18n.t('editor.save_as') }}</button><button class="btn" @click="saveDialog = false">{{ i18n.t('general.cancel') }}</button></div>
      </section>
    </div>
  </div>
</template>
