<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Live2DModelInfo } from '@pigeon-skin/shared/live2d';
import { ApiError, live2dApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import Live2DCanvas from '@/components/Live2DCanvas.vue';

const i18n = useI18n();
const models = ref<Live2DModelInfo[]>([]);
const selected = ref('');
const search = ref('');
const previewFailed = ref(false);
const desktopQuery = matchMedia('(min-width: 1024px)');
const desktop = ref(desktopQuery.matches);
const screenChanged = () => { desktop.value = desktopQuery.matches; };
desktopQuery.addEventListener('change', screenChanged);
onBeforeUnmount(() => { desktopQuery.removeEventListener('change', screenChanged); });
// 加载完成前按"默认禁用"呈现，避免配置尚未保存时开关显示为开
const enabled = ref(false);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const name = ref('');
const file = ref<File | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const preview = computed(() => models.value.find(model => model.id === selected.value));
const modelGroups = computed(() => {
  const term = search.value.trim().toLowerCase();
  const matches = models.value.filter(model => model.id === selected.value || !term || model.name.toLowerCase().includes(term));
  return [
    { label: 'live2d.uploaded_models', items: matches.filter(model => !model.builtin) },
    { label: 'live2d.cubism2_models', items: matches.filter(model => model.builtin && model.version === 2) },
    { label: 'live2d.cubism4_models', items: matches.filter(model => model.builtin && model.version === 4) },
  ].filter(group => group.items.length);
});
watch(selected, () => { previewFailed.value = false; });
function message(e: unknown) {
  return e instanceof ApiError ? i18n.t(e.fields.file || e.code) : i18n.t('common.network');
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await live2dApi.admin();
    models.value = data.items;
    selected.value = data.display.modelId;
    enabled.value = data.display.enabled;
  } catch (e) { error.value = message(e); }
  finally { loading.value = false; }
}
async function save() {
  if (busy.value || !preview.value) return;
  busy.value = true;
  error.value = notice.value = '';
  try {
    await live2dApi.save(enabled.value, selected.value);
    notice.value = i18n.t('live2d.saved');
    window.dispatchEvent(new Event('live2d-updated'));
  } catch (e) { error.value = message(e); }
  finally { busy.value = false; }
}
function chooseFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] || null;
  if (file.value && !name.value) name.value = file.value.name.replace(/\.zip$/i, '');
}
async function upload() {
  if (busy.value || !file.value || !name.value.trim()) return;
  error.value = notice.value = '';
  if (file.value.size > 20 * 1024 * 1024) { error.value = i18n.t('live2d.too_large'); return; }
  busy.value = true;
  try {
    const model = await live2dApi.upload(name.value.trim(), file.value);
    models.value.push(model);
    selected.value = model.id;
    name.value = '';
    file.value = null;
    if (fileInput.value) fileInput.value.value = '';
    notice.value = i18n.t('live2d.uploaded');
  } catch (e) { error.value = message(e); }
  finally { busy.value = false; }
}
onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="i18n.t('live2d.title')" />
    <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
    <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
    <AppSkeleton v-if="loading" :count="2" />
    <div v-else-if="!models.length" class="panel"><AppButton @click="load">{{ i18n.t('common.retry') }}</AppButton></div>
    <div v-else class="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div class="space-y-6">
        <AppForm class="panel space-y-4" @submit.prevent="save">
          <h2 class="font-semibold">{{ i18n.t('live2d.display') }}</h2>
          <div class="flex items-center gap-2"><AppSwitch v-model="enabled" :disabled="busy" :label="i18n.t('live2d.enabled')" /><span>{{ i18n.t('live2d.enabled') }}</span></div>
          <div>
            <label for="live2d-model" class="mb-2 block text-sm">{{ i18n.t('live2d.model') }}</label>
            <AppInput v-model="search" type="search" class="mb-2" :placeholder="i18n.t('live2d.search_models')" :aria-label="i18n.t('live2d.search_models')" :disabled="busy" />
            <AppSelect id="live2d-model" v-model="selected" :options="modelGroups.flatMap(group => group.items.map(model => ({ value: model.id, label: `${i18n.t(group.label)} · ${model.name}` })))" :disabled="busy" />
            <p class="mt-2 text-xs text-muted">{{ i18n.t('live2d.catalog_hint') }} <a class="text-brand underline" href="https://github.com/imuncle/live2d" target="_blank" rel="noopener noreferrer">imuncle/live2d</a></p>
          </div>
          <AppButton type="submit" class="btn-primary" :loading="busy">{{ i18n.t('common.save') }}</AppButton>
        </AppForm>
        <AppForm class="panel space-y-4" @submit.prevent="upload">
          <h2 class="font-semibold">{{ i18n.t('live2d.upload') }}</h2>
          <p class="text-sm text-muted">{{ i18n.t('live2d.upload_hint') }}</p>
          <div><label for="live2d-name" class="mb-2 block text-sm">{{ i18n.t('live2d.name') }}</label><AppInput id="live2d-name" v-model="name" maxlength="100" required :disabled="busy" /></div>
          <div><label for="live2d-file" class="mb-2 block text-sm">{{ i18n.t('live2d.package') }}</label><input id="live2d-file" ref="fileInput" class="input" type="file" accept=".zip,application/zip" required :disabled="busy" @change="chooseFile" /></div>
          <AppButton type="submit" class="btn-primary" :loading="busy" :disabled="!file || !name.trim()">{{ i18n.t('live2d.upload') }}</AppButton>
        </AppForm>
      </div>
      <section v-if="desktop && !previewFailed" class="panel flex flex-col items-center self-start">
        <h2 class="self-start font-semibold">{{ i18n.t('live2d.preview') }}</h2>
        <Transition name="live2d-model" mode="out-in">
          <Live2DCanvas v-if="preview" :key="preview.id" :model="preview" :width="280" :height="380" allow-transform @error="previewFailed = true" />
        </Transition>
        <p v-if="preview" class="text-sm text-muted">{{ preview.name }} · Cubism {{ preview.version === 2 ? '2' : '3/4' }}</p>
      </section>
    </div>
  </div>
</template>
