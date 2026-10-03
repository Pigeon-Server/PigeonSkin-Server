<script setup lang="ts">
import { confirmAction } from '@/stores/dialog';
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ApiError,
  textureApi,
  textureUrl,
  closetApi,
  reportApi,
  type TextureSummary,
} from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import { useSiteSettings } from '@/stores/site';
import TexturePreviewer from '@/components/TexturePreviewer.vue';
import SkinlibLoading from '@/components/SkinlibLoading.vue';
import ApplyTextureDialog from '@/components/ApplyTextureDialog.vue';
import MarkdownEditor from '@/components/ui/MarkdownEditor.vue';
import TextureComments from '@/components/TextureComments.vue';
import { applyPageMetadata, baseMetadata } from '@/lib/seo';
import { plainDescription } from '@pigeon-skin/shared/seo';
import { apiErrorMessage } from '@/lib/api-error';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const i18n = useI18n();
const site = useSiteSettings();

const tid = Number(route.params.tid);
const applyOpen = ref(false);
const loading = ref(true);
const busy = ref(false);
const descriptionBusy = ref(false);
const commentsTotal = ref(0);
const texture = ref<TextureSummary | null>(null);
const notFound = ref(false);
const collected = ref(false);
const notice = ref('');
const errMsg = ref('');
const reportOpen = ref(false);
const reportReason = ref('');
const editName = ref('');
const editVisibility = ref<'public' | 'private'>('public');
const editType = ref<'default' | 'slim' | 'cape'>('default');

const description = ref('');
const editingDescription = ref(false);
const editDescription = ref('');
const descErr = ref('');
const descriptionLimit = ref(0);

const commentsEnabled = computed(() => site.get('comments_enabled') !== 'false');
const isOwner = computed(
  () =>
    texture.value !== null &&
    session.user.value !== null &&
    texture.value.uploaderId === session.user.value.id,
);
const canManage = computed(() => isOwner.value || session.isAdmin.value);
const canEdit = computed(() => !!session.user.value && !!texture.value);
watch([texture, description, site.settings, notFound, i18n.locale], () => {
  const item = texture.value;
  const siteName = site.get('site_name') || 'Pigeon Skin Server';
  const kind = i18n.t(item?.kind === 'cape' ? 'general.cape' : 'general.skin');
  const metadata = baseMetadata(route.path, '', site.settings.value, item ? `${item.name} · Minecraft ${kind} · ${siteName}` : `${i18n.t(notFound.value ? 'common.not_found' : 'seo.home')} · ${siteName}`);
  metadata.indexable = item?.visibility === 'public' && !notFound.value;
  if (item && metadata.indexable) {
    metadata.description = plainDescription(description.value || i18n.t('seo.texture_description', { name: item.name, kind, width: item.width, height: item.height }));
    metadata.image = new URL(`/preview/${item.hash}`, site.get('site_url') || location.origin).href;
    metadata.structuredData = [{ '@type': 'CreativeWork', name: item.name, description: metadata.description, url: metadata.canonical, image: metadata.image }];
  }
  applyPageMetadata(metadata);
}, { immediate: true });

onMounted(async () => {
  await site.fetch().then(() => {
    const n = Number(site.get('textures_description_limit'));
    descriptionLimit.value = Number.isInteger(n) && n > 0 ? n : 0;
  });
  if (!Number.isInteger(tid) || tid <= 0) {
    notFound.value = true;
    loading.value = false;
    return;
  }
  try {
    texture.value = await textureApi.get(tid);
    editName.value = texture.value.name;
    editVisibility.value = texture.value.visibility;
    editType.value =
      texture.value.kind === 'cape' ? 'cape' : texture.value.model === 'slim' ? 'slim' : 'default';
    if (session.user.value) {
      const closet = await closetApi.list();
      collected.value = closet.items.some((e) => e.textureId === tid);
    }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
      notFound.value = true;
      errMsg.value =
        e.status === 403 ? i18n.t('skinlib.no-permission') : i18n.t('skinlib.non-existent');
    } else {
      errMsg.value = i18n.t('common.internal_error');
    }
    loading.value = false;
    return;
  }
  loading.value = false;
  // 描述与评论独立加载，失败不阻塞详情
  void loadDescription();
});

function jumpToComments() { document.getElementById('texture-comments')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }

async function loadDescription() {
  try {
    description.value = (await textureApi.getDescription(tid)).description;
  } catch (e) {
    descErr.value = apiErrorMessage(e);
  }
}

async function saveDescription() {
  descErr.value = '';
  if (descriptionLimit.value > 0 && editDescription.value.length > descriptionLimit.value) {
    descErr.value = i18n.t('skinlib.description_too_long');
    return;
  }
  if (descriptionBusy.value) return;
  descriptionBusy.value = true;
  try {
    await textureApi.putDescription(tid, editDescription.value);
    description.value = editDescription.value;
    editingDescription.value = false;
    notice.value = i18n.t('skinlib.description_saved');
  } catch (e) {
    descErr.value = apiErrorMessage(e);
  } finally {
    descriptionBusy.value = false;
  }
}

async function toggleCollect() {
  if (!texture.value) return;
  if (busy.value) return;
  busy.value = true;
  errMsg.value = '';
  try {
    if (collected.value) {
      await closetApi.remove(tid);
      collected.value = false;
      texture.value.likes--;
    } else {
      await closetApi.add(tid);
      collected.value = true;
      texture.value.likes++;
    }
    await session.fetchSession();
  } catch (e) {
    errMsg.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function submitReport() {
  if (!reportReason.value.trim()) return;
  if (busy.value) return;
  busy.value = true;
  errMsg.value = '';
  try {
    await reportApi.submit(tid, reportReason.value.trim());
    reportOpen.value = false;
    reportReason.value = '';
    notice.value = i18n.t('skinlib.report.success');
  } catch (e) {
    errMsg.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function saveEdits() {
  if (
    texture.value &&
    (editType.value === 'cape') !== (texture.value.kind === 'cape') &&
    !(await confirmAction(i18n.t('texture.type_change_confirm')))
  )
    return;
  if (busy.value) return;
  busy.value = true;
  try {
    const patch: {
      name?: string;
      visibility?: 'public' | 'private';
      kind?: 'skin' | 'cape';
      model?: 'default' | 'slim';
    } = {};
    if (editName.value !== texture.value?.name) patch.name = editName.value;
    if (editVisibility.value !== texture.value?.visibility) patch.visibility = editVisibility.value;
    const type = texture.value?.kind === 'cape' ? 'cape' : texture.value?.model;
    if (editType.value !== type) {
      patch.kind = editType.value === 'cape' ? 'cape' : 'skin';
      if (editType.value !== 'cape') patch.model = editType.value;
    }
    await textureApi.patch(tid, patch);
    await session.fetchSession();
    if (texture.value) {
      texture.value = await textureApi.get(tid);
    }
    notice.value = i18n.t('general.op-success');
  } catch (e) {
    errMsg.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function removeTexture() {
  if (!(await confirmAction(i18n.t('skinlib.deleteNotice')))) return;
  if (busy.value) return;
  busy.value = true;
  try {
    await textureApi.remove(tid);
    void router.push('/skinlib');
  } catch (e) {
    errMsg.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <SkinlibLoading v-if="loading" />
  <div
    v-if="notFound"
    class="mx-auto max-w-lg rounded-xl border border-line bg-surface p-10 text-center"
  >
    <span class="material-icons mx-auto text-muted" style="font-size: 48px">texture</span>
    <p class="mt-3 text-muted">{{ errMsg || i18n.t('skinlib.non-existent') }}</p>
    <router-link to="/skinlib" class="btn btn-primary mt-4 inline-block">
      {{ i18n.t('general.skinlib') }}
    </router-link>
  </div>

  <div v-else-if="texture" class="mx-auto w-full max-w-[1120px] space-y-6">
    <PageHeader :title="texture.name">
      <AppButton v-if="commentsEnabled" @click="jumpToComments"><AppIcon name="chat_bubble_outline" />{{ i18n.t('comments.navigation', { count: i18n.n(commentsTotal) }) }}</AppButton>
      <router-link to="/skinlib" class="btn">
        <AppIcon name="arrow_back" />
        {{ i18n.t('general.back') }}
      </router-link>
    </PageHeader>
    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div class="panel !p-0 overflow-hidden">
        <div class="bg-surface-2">
          <TexturePreviewer
            :skin-url="texture.kind === 'skin' ? textureUrl(texture.hash) : null"
            :cape-url="texture.kind === 'cape' ? textureUrl(texture.hash) : null"
            :slim="texture.model === 'slim'"
            :height="580"
            :name="texture.name"
          />
        </div>
      </div>

      <div class="space-y-4">
        <div class="rounded-xl border border-line bg-surface p-5">
          <div class="flex items-center gap-2">
            <span
              class="badge"
              :class="texture.visibility === 'public' ? 'badge-success' : 'badge-default'"
            >
              {{ texture.visibility === 'public' ? i18n.t('general.public') : i18n.t('general.private') }}
            </span>
          </div>
          <dl class="mt-3 space-y-1 text-sm">
            <div v-if="texture.sourceResourceId" class="text-right"><router-link class="text-brand-600 hover:underline" :to="`/skinlib/${texture.sourceResourceId}`">{{ i18n.t('editor.source', { name: texture.sourceResourceName || `#${texture.sourceResourceId}` }) }}</router-link></div>
            <div class="flex justify-between">
              <dt class="text-muted">{{ i18n.t('skinlib.show.uploader') }}</dt>
              <dd>{{ texture.official ? i18n.t('skinlib.official_resource') : texture.uploaderName ?? i18n.t('admin.anonymous') }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted">{{ i18n.t('skinlib.resolution') }}</dt>
              <dd>
                {{ i18n.t('common.dimensions', { width: i18n.n(texture.width), height: i18n.n(texture.height) }) }}
              </dd>
            </div>
            <div class="flex justify-between">
              <dt v-if="!texture.official" class="text-muted">{{ i18n.t('skinlib.show.upload-at') }}</dt>
              <dd v-if="!texture.official">{{ i18n.d(texture.createdAt, 'short') }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted">{{ i18n.t('skinlib.show.likes') }}</dt>
              <dd>{{ i18n.n(texture.likes) }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted">{{ i18n.t('skinlib.texture_type') }}</dt>
              <dd>
                {{ i18n.t(texture.kind === 'cape' ? 'general.cape' : texture.model === 'slim' ? 'skinlib.model_slim' : 'skinlib.model_classic') }}
              </dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted">{{ i18n.t('skinlib.file_size') }}</dt>
              <dd>{{ i18n.t('common.size_kb', { size: i18n.n(texture.sizeBytes / 1024) }) }}</dd>
            </div>
            <div class="pt-2">
              <dt class="text-muted">{{ i18n.t('skinlib.hash') }}</dt>
              <dd class="font-mono text-xs break-all mt-1">{{ texture.hash }}</dd>
            </div>
          </dl>

          <div class="mt-4 grid grid-cols-2 gap-2">
            <AppButton
              v-if="session.user.value"
              class="btn"
              :class="collected ? 'btn-success' : ''"
              :loading="busy"
              @click="toggleCollect"
            >
              {{ collected ? i18n.t('skinlib.removeFromCloset') : i18n.t('skinlib.addToCloset') }}
            </AppButton>
            <a
              v-if="site.get('allow_texture_download') !== 'false'"
              class="btn text-center"
              :href="`/raw/${tid}`"
              download
            >
              {{ i18n.t('skinlib.show.download') }}
            </a>
            <AppButton
              v-if="session.user.value"
              class="btn col-span-2 btn-primary"
              @click="applyOpen = true"
            >
              {{ i18n.t('skinlib.apply') }}
            </AppButton>
            <router-link v-if="canEdit" class="btn col-span-2 text-center" :to="`/editor/${texture.kind}?texture=${texture.id}`">
              {{ i18n.t('editor.edit') }}
            </router-link>
            <AppButton
              v-if="session.user.value"
              class="btn col-span-2"
              @click="reportOpen = !reportOpen"
            >
              {{ i18n.t('skinlib.report.title') }}
            </AppButton>
          </div>

          <AppDialog v-model="reportOpen" :title="i18n.t('skinlib.report.title')" :busy="busy">
            <AppForm class="space-y-3" @submit.prevent="submitReport">
              <p v-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}</p>
              <label for="report-reason">{{ i18n.t('skinlib.report.reason') }}</label>
              <AppInput
                id="report-reason"
                v-model="reportReason"
                multiline
                class="h-28"
                maxlength="1000"
                required
              />
              <AppButton type="submit" class="btn-danger w-full" :loading="busy">
                {{ i18n.t('general.submit') }}
              </AppButton>
            </AppForm>
          </AppDialog>
        </div>

        <div v-if="canManage" class="rounded-xl border border-line bg-surface p-5">
          <h2 class="font-semibold">{{ i18n.t('admin-panel.manage') }}</h2>
          <div class="mt-3 space-y-3">
            <div>
              <label class="mb-1 block text-sm font-medium" for="tname">
                {{ i18n.t('skinlib.show.name') }}
              </label>
              <AppInput id="tname" v-model="editName" />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium" for="tvis">
                {{ i18n.t('common.visibility') }}
              </label>
              <AppSelect id="tvis" v-model="editVisibility" :options="[{ value: 'public', label: i18n.t('general.public') }, { value: 'private', label: i18n.t('general.private') }]" />
              <p v-if="editVisibility === 'private'" class="mt-2 text-xs text-muted">
                {{ i18n.t('skinlib.private_hint') }}
              </p>
            </div>
            <div class="flex gap-2">
              <AppSelect v-model="editType" :options="[{ value: 'default', label: i18n.t('skinlib.model_classic') }, { value: 'slim', label: i18n.t('skinlib.model_slim') }, { value: 'cape', label: i18n.t('general.cape') }]" :aria-label="i18n.t('skinlib.texture_type')" />
              <AppButton class="btn btn-primary flex-1" :loading="busy" @click="saveEdits">
                {{ i18n.t('common.save') }}
              </AppButton>
              <AppButton
                class="btn btn-danger"
                :disabled="busy"
                :aria-label="i18n.t('common.delete')"
                @click="removeTexture"
              >
                <AppIcon name="delete" />
              </AppButton>
            </div>
          </div>
        </div>

        <p v-if="notice" class="alert alert-success">{{ notice }}</p>
        <p v-if="errMsg" class="alert alert-danger">{{ errMsg }}</p>
      </div>
    </div>

    <div class="rounded-xl border border-line bg-surface p-5">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">{{ i18n.t('skinlib.description') }}</h2>
        <AppButton
          v-if="canManage && !editingDescription"
          class="btn btn-sm"
          @click="editingDescription = true; editDescription = description; descErr = ''"
        >
          {{ i18n.t('skinlib.description_edit') }}
        </AppButton>
      </div>
      <template v-if="editingDescription">
        <MarkdownEditor
          v-model="editDescription"
          :label="i18n.t('skinlib.description_edit')"
          :limit="descriptionLimit"
          :disabled="descriptionBusy"
          class="mt-3"
        />
        <p v-if="descErr" class="alert alert-danger mt-2">{{ descErr }}</p>
        <div class="mt-2 flex gap-2">
          <AppButton class="btn btn-primary" :loading="descriptionBusy" @click="saveDescription">
            {{ i18n.t('common.save') }}
          </AppButton>
          <AppButton class="btn" @click="editingDescription = false">
            {{ i18n.t('general.cancel') }}
          </AppButton>
        </div>
      </template>
      <MarkdownContent v-else-if="description" :content="description" class="mt-3" />
      <p v-else class="mt-3 text-sm text-muted">{{ i18n.t('skinlib.description_empty') }}</p>
      <p v-if="descErr && !editingDescription" class="text-xs text-danger mt-2">
        {{ descErr }}
        <AppButton class="btn-sm ml-2" @click="loadDescription">
          {{ i18n.t('common.retry') }}
        </AppButton>
      </p>
    </div>

    <TextureComments v-if="commentsEnabled" :texture-id="tid" @count="commentsTotal = $event" />
  </div>

  <p v-else-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}</p>
  <ApplyTextureDialog
    v-if="texture"
    v-model="applyOpen"
    :texture-id="tid"
    :kind="texture.kind"
    @applied="notice = i18n.t('player.applied')"
  />
</template>
