<script setup lang="ts">
import { confirmAction } from '@/stores/dialog';
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
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
import VerificationChallenge from '@/components/VerificationChallenge.vue';
import { applyPageMetadata, baseMetadata } from '@/lib/seo';
import { plainDescription } from '@pigeon-skin/shared/seo';
import { apiErrorMessage } from '@/lib/api-error';
import { withSkinlibChallenge } from '@/stores/skinlib-challenge';

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
// 本账号对该材质有待处理的举报时不再显示举报入口（处理完成后可再次举报）
const reportPending = ref(false);
const reportCaptchaToken = ref('');
const reportCaptchaRandstr = ref('');
const reportChallenge = ref<InstanceType<typeof VerificationChallenge> | null>(null);
const editName = ref('');
const editVisibility = ref<'public' | 'private'>('public');
const editType = ref<'default' | 'slim' | 'cape'>('default');

const description = ref('');
const translatedDescription = ref('');
const editingDescription = ref(false);
const editDescription = ref('');
const descErr = ref('');
const descriptionLimit = ref(0);

const hashCopied = ref(false);
let copyTimer = 0;

const commentsEnabled = computed(() => site.get('comments_enabled') !== 'false');
// 评论区只存在于公开的非官方材质：私密材质不设评论区，官方材质是站点自有内容
const canComment = computed(() => commentsEnabled.value && texture.value?.visibility === 'public' && !texture.value?.official);
const isOwner = computed(
  () =>
    texture.value !== null &&
    session.user.value !== null &&
    texture.value.uploaderId === session.user.value.id,
);
const canManage = computed(() => isOwner.value || session.isAdmin.value);
const canEdit = computed(() => Boolean(session.user.value && texture.value));
const canDownload = computed(
  () =>
    site.get('allow_texture_download') !== 'false' &&
    (session.user.value !== null || site.get('allow_anonymous_download') !== 'false'),
);

watch(
  [texture, description, site.settings, notFound, i18n.locale],
  () => {
    const item = texture.value;
    const siteName = site.get('site_name') || 'Pigeon Skin Server';
    const kind = i18n.t(item?.kind === 'cape' ? 'general.cape' : 'general.skin');
    const metadata = baseMetadata(
      route.path,
      '',
      site.settings.value,
      item
        ? `${item.name} · Minecraft ${kind} · ${siteName}`
        : `${i18n.t(notFound.value ? 'common.not_found' : 'seo.home')} · ${siteName}`,
    );
    metadata.indexable = item?.visibility === 'public' && !notFound.value;
    if (item && metadata.indexable) {
      metadata.description = plainDescription(
        description.value ||
          i18n.t('seo.texture_description', {
            name: item.name,
            kind,
            width: item.width,
            height: item.height,
          }),
      );
      metadata.image = new URL(
        `/preview/${item.hash}`,
        site.get('site_url') || location.origin,
      ).href;
      metadata.structuredData = [
        {
          '@type': 'CreativeWork',
          name: item.name,
          description: metadata.description,
          url: metadata.canonical,
          image: metadata.image,
        },
      ];
    }
    applyPageMetadata(metadata);
  },
  { immediate: true },
);

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
    texture.value = await withSkinlibChallenge((headers) => textureApi.get(tid, i18n.locale.value, headers));
    editName.value = texture.value.name;
    editVisibility.value = texture.value.visibility;
    editType.value =
      texture.value.kind === 'cape'
        ? 'cape'
        : texture.value.model === 'slim'
          ? 'slim'
          : 'default';

    if (session.user.value) {
      const closet = await closetApi.list({ perPage: 1000 });
      collected.value = closet.items.some((e) => e.textureId === tid);
      reportPending.value = (await reportApi.mine()).items.some(
        (r) => r.textureId === tid && r.status === 'pending',
      );
    }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
      notFound.value = true;
      errMsg.value =
        e.status === 403
          ? i18n.t('skinlib.no-permission')
          : i18n.t('skinlib.non-existent');
    } else {
      errMsg.value = i18n.t('common.internal_error');
    }
    loading.value = false;
    return;
  }

  loading.value = false;
  void loadDescription();
});

onBeforeUnmount(() => {
  window.clearTimeout(copyTimer);
});

function jumpToComments() {
  document.getElementById('texture-comments')?.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth',
    block: 'start',
  });
}

async function copyHash() {
  if (!texture.value?.hash) return;
  try {
    await navigator.clipboard.writeText(texture.value.hash);
    hashCopied.value = true;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      hashCopied.value = false;
    }, 2000);
  } catch {
    // 忽略剪贴板写入失败
  }
}

async function loadDescription() {
  try {
    const result = await withSkinlibChallenge((headers) => textureApi.getDescription(tid, i18n.locale.value, headers));
    description.value = result.description;
    // 当前语言的 AI 译文；与原文相同（源语言即当前语言）时不重复展示
    translatedDescription.value = result.translatedDescription && result.translatedDescription !== result.description
      ? result.translatedDescription
      : '';
  } catch (e) {
    descErr.value = apiErrorMessage(e);
  }
}

async function saveDescription() {
  descErr.value = '';
  if (
    descriptionLimit.value > 0 &&
    editDescription.value.length > descriptionLimit.value
  ) {
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

function handleApplyClick() {
  if (!session.user.value) {
    void router.push({ path: '/login', query: { redirect: route.fullPath } });
    return;
  }
  applyOpen.value = true;
}

async function toggleCollect() {
  if (!session.user.value) {
    void router.push({ path: '/login', query: { redirect: route.fullPath } });
    return;
  }
  if (!texture.value || busy.value) return;

  busy.value = true;
  errMsg.value = '';
  const wasCollected = collected.value;

  // 乐观更新
  collected.value = !wasCollected;
  texture.value.likes += wasCollected ? -1 : 1;

  try {
    if (wasCollected) {
      await closetApi.remove(tid);
    } else {
      await closetApi.add(tid);
    }
    await session.fetchSession();
  } catch (e) {
    // 回滚
    collected.value = wasCollected;
    texture.value.likes += wasCollected ? 1 : -1;
    errMsg.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function submitReport() {
  if (!reportReason.value.trim() || busy.value) return;
  busy.value = true;
  errMsg.value = '';
  try {
    await reportApi.submit(tid, reportReason.value.trim(), reportCaptchaToken.value, reportCaptchaRandstr.value);
    reportOpen.value = false;
    reportReason.value = '';
    reportCaptchaToken.value = '';
    reportCaptchaRandstr.value = '';
    reportPending.value = true;
    notice.value = i18n.t('skinlib.report.success');
  } catch (e) {
    reportChallenge.value?.reset();
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
  ) {
    return;
  }

  if (busy.value) return;
  busy.value = true;
  errMsg.value = '';
  notice.value = '';

  try {
    const patch: {
      name?: string;
      visibility?: 'public' | 'private';
      kind?: 'skin' | 'cape';
      model?: 'default' | 'slim';
    } = {};

    if (editName.value !== texture.value?.name) patch.name = editName.value;
    if (editVisibility.value !== texture.value?.visibility) {
      patch.visibility = editVisibility.value;
    }

    const currentType =
      texture.value?.kind === 'cape' ? 'cape' : texture.value?.model;
    if (editType.value !== currentType) {
      patch.kind = editType.value === 'cape' ? 'cape' : 'skin';
      if (editType.value !== 'cape') patch.model = editType.value;
    }

    await textureApi.patch(tid, patch);
    await session.fetchSession();
    texture.value = await withSkinlibChallenge((headers) => textureApi.get(tid, i18n.locale.value, headers));
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
  <!-- 内容优先的详情页：返回行与卡片内标题共同构成页头，因此不使用 PageHeader。 -->
  <div class="page page--dense">
    <!-- 顶部返回行：加载、异常与正常状态都保留返回入口 -->
    <nav class="page-breadcrumb" :aria-label="i18n.t('skinlib.show.title')">
      <div class="flex items-center gap-2">
        <router-link
          to="/skinlib"
          class="page-back"
        >
          <AppIcon name="arrow_back" class="!text-sm" />
          <span>{{ i18n.t('general.skinlib') }}</span>
        </router-link>
        <template v-if="texture">
          <span class="text-muted/60">/</span>
          <span class="max-w-[260px] truncate font-semibold text-ink sm:max-w-md" :title="texture.name">
            {{ texture.name }}
          </span>
        </template>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <AppButton
          v-if="canComment"
          class="btn-sm"
          @click="jumpToComments"
        >
          <AppIcon name="chat_bubble_outline" class="!text-sm" />
          <span>{{ i18n.t('comments.navigation', { count: i18n.n(commentsTotal) }) }}</span>
        </AppButton>
      </div>
    </nav>

    <!-- 加载中状态 -->
    <SkinlibLoading v-if="loading" />

    <!-- 404 / 403 异常状态 -->
    <div
      v-else-if="notFound"
      class="mx-auto max-w-lg rounded-xl border border-line bg-surface p-10 text-center shadow-sm"
    >
      <span class="material-icons mx-auto text-muted" style="font-size: 56px">texture</span>
      <h2 class="mt-4 text-lg font-semibold">{{ errMsg || i18n.t('skinlib.non-existent') }}</h2>
      <p class="mt-2 text-sm text-muted">{{ i18n.t('skinlib.show.manage-notice') }}</p>
    </div>

    <!-- 详情主视区 -->
    <div v-else-if="texture" class="w-full space-y-6">
      <!-- 反馈信息横幅 -->
      <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
      <p v-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}</p>

      <!-- 双栏响应式内容网格 -->
      <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <!-- 左侧主列：预览器 + 描述 + 评论 -->
        <div class="space-y-6 min-w-0">
          <!-- 材质预览展示卡片 -->
          <div class="panel !p-0 overflow-hidden shadow-sm">
            <div class="bg-surface-2">
              <TexturePreviewer
                :skin-url="texture.kind === 'skin' ? textureUrl(texture.hash) : null"
                :cape-url="texture.kind === 'cape' ? textureUrl(texture.hash) : null"
                :slim="texture.model === 'slim'"
                :height="520"
                :name="texture.name"
              />
            </div>
          </div>

          <!-- 材质图文描述卡片 -->
          <div class="rounded-xl border border-line bg-surface p-5 shadow-sm">
            <div class="flex items-center justify-between pb-3 border-b border-line/60">
              <div class="flex items-center gap-2">
                <AppIcon name="description" class="text-brand-600 !text-xl" />
                <h2 class="font-semibold">{{ i18n.t('skinlib.description') }}</h2>
              </div>
              <AppButton
                v-if="canManage && !editingDescription"
                class="btn-sm"
                @click="editingDescription = true; editDescription = description; descErr = ''"
              >
                <AppIcon name="edit" class="!text-xs" />
                <span>{{ i18n.t('skinlib.description_edit') }}</span>
              </AppButton>
            </div>

            <!-- 编辑模式 -->
            <template v-if="editingDescription">
              <MarkdownEditor
                v-model="editDescription"
                :label="i18n.t('skinlib.description_edit')"
                :limit="descriptionLimit"
                :disabled="descriptionBusy"
                class="mt-3"
              />
              <p v-if="descErr" class="alert alert-danger mt-2" role="alert">{{ descErr }}</p>
              <div class="mt-3 flex gap-2">
                <AppButton
                  class="btn-primary"
                  :loading="descriptionBusy"
                  @click="saveDescription"
                >
                  <AppIcon name="save" />
                  <span>{{ i18n.t('common.save') }}</span>
                </AppButton>
                <AppButton class="btn" @click="editingDescription = false">
                  {{ i18n.t('general.cancel') }}
                </AppButton>
              </div>
            </template>

            <!-- 渲染模式：有译文时主显译文，可展开原文 -->
            <template v-else-if="description">
              <details v-if="translatedDescription" class="mt-4">
                <summary class="cursor-pointer select-none text-xs text-muted hover:text-brand-600">
                  {{ i18n.t('skinlib.description_original') }}
                </summary>
                <MarkdownContent
                  :content="description"
                  class="prose max-w-none mt-2 opacity-80"
                />
              </details>
              <MarkdownContent
                v-if="translatedDescription"
                :content="translatedDescription"
                class="prose max-w-none"
              />
              <MarkdownContent
                v-else
                :content="description"
                class="mt-4 prose max-w-none"
              />
            </template>
            <p v-else class="mt-4 text-sm text-muted italic">
              {{ i18n.t('skinlib.description_empty') }}
            </p>

            <p v-if="descErr && !editingDescription" class="mt-2 text-xs text-danger">
              {{ descErr }}
              <AppButton class="btn-sm ml-2" @click="loadDescription">
                {{ i18n.t('common.retry') }}
              </AppButton>
            </p>
          </div>

          <!-- 社区评论区 -->
          <div id="texture-comments">
            <TextureComments
              v-if="canComment"
              :texture-id="tid"
              @count="commentsTotal = $event"
            />
          </div>
        </div>

        <!-- 右侧侧边栏：操作 + 详细元信息 + 管理面板 -->
        <div class="space-y-5">
          <!-- 材质核心行动与属性卡片 -->
          <div class="rounded-xl border border-line bg-surface p-5 shadow-sm space-y-4">
            <!-- 标题与状态徽章 -->
            <div>
              <h1 class="text-xl font-bold tracking-tight text-ink break-words" :title="texture.name">
                {{ texture.name }}
              </h1>
              <div class="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
                <!-- 模型类型 -->
                <span class="badge !bg-surface-2 font-medium">
                  {{ i18n.t(texture.kind === 'cape' ? 'general.cape' : texture.model === 'slim' ? 'skinlib.model_slim' : 'skinlib.model_classic') }}
                </span>

                <!-- 可见性 -->
                <span
                  class="badge inline-flex items-center gap-1"
                  :class="texture.visibility === 'public' ? 'badge-success' : 'badge-default !bg-amber-500/15 !text-amber-600 dark:!text-amber-400'"
                >
                  <AppIcon v-if="texture.visibility === 'private'" name="lock" class="!text-xs" />
                  <span>{{ texture.visibility === 'public' ? i18n.t('general.public') : i18n.t('general.private') }}</span>
                </span>

                <!-- 官方 / 来源 -->
                <span
                  v-if="texture.official || texture.origin === 'repost'"
                  class="badge !bg-brand-500/15 !text-brand-600 dark:!text-brand-300 font-medium"
                >
                  {{ texture.official ? i18n.t('skinlib.official_resource') : i18n.t('skinlib.origin_repost') }}
                </span>
              </div>

              <!-- 衍生来源链接 -->
              <div v-if="texture.sourceResourceId" class="mt-2 text-xs">
                <router-link
                  class="text-brand-600 hover:underline inline-flex items-center gap-1"
                  :to="`/skinlib/${texture.sourceResourceId}`"
                >
                  <AppIcon name="link" class="!text-xs" />
                  <span>{{ i18n.t('editor.source', { name: texture.sourceResourceName || `#${texture.sourceResourceId}` }) }}</span>
                </router-link>
              </div>
            </div>

            <!-- 操作行动按钮区 -->
            <div class="space-y-2 pt-1 border-t border-line/60">
              <!-- 首要行动：应用到角色 -->
              <AppButton
                class="btn-primary w-full !py-2.5 !text-sm font-semibold justify-center"
                @click="handleApplyClick"
              >
                <AppIcon name="checkroom" class="!text-lg" />
                <span>{{ i18n.t('skinlib.apply') }}</span>
              </AppButton>

              <!-- 次要行动网格 -->
              <div class="grid grid-cols-2 gap-2">
                <!-- 收藏至衣柜 -->
                <AppButton
                  class="btn !text-xs justify-center"
                  :class="collected ? '!border-rose-500 !text-rose-500' : ''"
                  :loading="busy"
                  @click="toggleCollect"
                >
                  <AppIcon
                    :name="collected ? 'favorite' : 'favorite_border'"
                    class="!text-base"
                    :class="collected ? '!text-rose-500' : ''"
                  />
                  <span>{{ collected ? i18n.t('skinlib.removeFromCloset') : i18n.t('skinlib.addToCloset') }}</span>
                </AppButton>

                <!-- 下载材质 -->
                <a
                  v-if="canDownload"
                  class="btn !text-xs justify-center"
                  :href="`/raw/${tid}`"
                  :download="`${texture.name || 'texture'}.png`"
                >
                  <AppIcon name="download" class="!text-base" />
                  <span>{{ i18n.t('skinlib.show.download') }}</span>
                </a>
              </div>

              <!-- 辅助行动栏 -->
              <div class="flex items-center gap-2 pt-1">
                <!-- 在线制作/编辑 -->
                <router-link
                  v-if="canEdit"
                  class="btn flex-1 !text-xs justify-center"
                  :to="`/editor/${texture.kind}?texture=${texture.id}`"
                  :title="i18n.t('editor.edit')"
                >
                  <AppIcon name="brush" class="!text-base" />
                  <span>{{ i18n.t('editor.edit') }}</span>
                </router-link>

                <!-- 举报违规（官方材质不提供举报；拥有者不显示：不能举报自己的材质；被禁用举报或已有待处理举报时不显示） -->
                <AppButton
                  v-if="session.user.value && !isOwner && !texture.official && !session.user.value.reportingDisabled && !reportPending"
                  class="btn flex-1 !text-xs justify-center text-muted hover:text-danger"
                  :title="i18n.t('skinlib.report.title')"
                  @click="reportOpen = true"
                >
                  <AppIcon name="flag" class="!text-base" />
                  <span>{{ i18n.t('skinlib.report.title') }}</span>
                </AppButton>
              </div>
            </div>

            <!-- 详细属性参数列表 -->
            <dl class="space-y-2 pt-2 border-t border-line/60 text-xs">
              <div class="flex items-center justify-between">
                <dt class="text-muted">{{ i18n.t('skinlib.show.uploader') }}</dt>
                <dd>
                  <router-link
                    v-if="!texture.official && texture.uploaderId"
                    :to="`/user/${texture.uploaderId}`"
                    class="text-brand-600 hover:underline font-medium"
                  >
                    {{ texture.uploaderName || i18n.t('admin.anonymous') }}
                  </router-link>
                  <span v-else>{{ texture.official ? i18n.t('skinlib.official_resource') : i18n.t('admin.anonymous') }}</span>
                </dd>
              </div>

              <div class="flex items-center justify-between">
                <dt class="text-muted">{{ i18n.t('skinlib.resolution') }}</dt>
                <dd class="font-mono">
                  {{ i18n.t('common.dimensions', { width: i18n.n(texture.width), height: i18n.n(texture.height) }) }}
                </dd>
              </div>

              <div class="flex items-center justify-between">
                <dt class="text-muted">{{ i18n.t('skinlib.file_size') }}</dt>
                <dd>{{ i18n.t('common.size_kb', { size: i18n.n(Math.round((texture.sizeBytes / 1024) * 10) / 10) }) }}</dd>
              </div>

              <div v-if="!texture.official" class="flex items-center justify-between">
                <dt class="text-muted">{{ i18n.t('skinlib.show.upload-at') }}</dt>
                <dd>{{ i18n.d(texture.createdAt, 'short') }}</dd>
              </div>

              <div class="flex items-center justify-between">
                <dt class="text-muted">{{ i18n.t('skinlib.show.likes') }}</dt>
                <dd class="font-medium">{{ i18n.n(texture.likes) }}</dd>
              </div>

              <!-- 哈希值与复制小工具（仅管理员可见） -->
              <div v-if="session.isAdmin.value" class="pt-2 border-t border-line/40">
                <div class="flex items-center justify-between text-xs">
                  <dt class="text-muted">{{ i18n.t('skinlib.hash') }}</dt>
                  <dd>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
                      @click="copyHash"
                    >
                      <AppIcon :name="hashCopied ? 'check' : 'content_copy'" class="!text-xs" />
                      <span>{{ i18n.t(hashCopied ? 'common.copied' : 'common.copy') }}</span>
                    </button>
                  </dd>
                </div>
                <code class="mt-1 block font-mono text-[11px] break-all rounded bg-surface-2 px-2 py-1 text-muted select-all">
                  {{ texture.hash }}
                </code>
              </div>
            </dl>
          </div>

          <!-- 作者 / 管理员管理卡片 -->
          <div v-if="canManage" class="rounded-xl border border-line bg-surface p-5 shadow-sm space-y-4">
            <div class="flex items-center justify-between pb-2 border-b border-line/60">
              <div class="flex items-center gap-2">
                <AppIcon name="tune" class="text-brand-600" />
                <h2 class="font-semibold text-sm">{{ i18n.t('admin-panel.manage') }}</h2>
              </div>
              <span class="badge !text-[11px] !bg-surface-2">
                {{ isOwner ? i18n.t('general.owner') : i18n.t('admin.role_admin') }}
              </span>
            </div>

            <div class="space-y-3 pt-1">
              <div>
                <label class="mb-1 block text-xs font-medium text-muted" for="tname">
                  {{ i18n.t('skinlib.show.name') }}
                </label>
                <AppInput id="tname" v-model="editName" class="w-full" />
              </div>

              <div>
                <label class="mb-1 block text-xs font-medium text-muted" for="tvis">
                  {{ i18n.t('common.visibility') }}
                </label>
                <AppSelect
                  id="tvis"
                  v-model="editVisibility"
                  :options="[
                    { value: 'public', label: i18n.t('general.public') },
                    { value: 'private', label: i18n.t('general.private') },
                  ]"
                />
                <p v-if="editVisibility === 'private'" class="mt-1.5 text-xs text-muted">
                  {{ i18n.t('skinlib.private_hint') }}
                </p>
              </div>

              <div>
                <label class="mb-1 block text-xs font-medium text-muted">
                  {{ i18n.t('skinlib.texture_type') }}
                </label>
                <AppSelect
                  v-model="editType"
                  :options="[
                    { value: 'default', label: i18n.t('skinlib.model_classic') },
                    { value: 'slim', label: i18n.t('skinlib.model_slim') },
                    { value: 'cape', label: i18n.t('general.cape') },
                  ]"
                />
              </div>

              <div class="flex items-center gap-2 pt-2">
                <AppButton class="btn-primary flex-1 !py-2 justify-center" :loading="busy" @click="saveEdits">
                  <AppIcon name="save" />
                  <span>{{ i18n.t('common.save') }}</span>
                </AppButton>
                <AppButton
                  class="btn-danger !px-3 !py-2"
                  :disabled="busy"
                  :title="i18n.t('skinlib.show.delete-texture')"
                  @click="removeTexture"
                >
                  <AppIcon name="delete_outline" />
                </AppButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 举报对话框 -->
    <AppDialog v-model="reportOpen" :title="i18n.t('skinlib.report.title')" :busy="busy">
      <AppForm class="space-y-3" @submit.prevent="submitReport">
        <p v-if="errMsg" class="alert alert-danger" role="alert">{{ errMsg }}</p>
        <label for="report-reason" class="text-sm font-medium">{{ i18n.t('skinlib.report.reason') }}</label>
        <AppInput
          id="report-reason"
          v-model="reportReason"
          multiline
          class="h-28"
          maxlength="1000"
          required
        />
        <VerificationChallenge ref="reportChallenge" v-model="reportCaptchaToken" v-model:randstr="reportCaptchaRandstr" />
        <div class="flex justify-end gap-2 pt-2">
          <AppButton type="button" class="btn" @click="reportOpen = false">
            {{ i18n.t('general.cancel') }}
          </AppButton>
          <AppButton type="submit" class="btn-danger" :loading="busy">
            {{ i18n.t('general.submit') }}
          </AppButton>
        </div>
      </AppForm>
    </AppDialog>

    <!-- 应用到角色对话框 -->
    <ApplyTextureDialog
      v-if="texture"
      v-model="applyOpen"
      :texture-id="tid"
      :kind="texture.kind"
      @applied="notice = i18n.t('player.applied')"
    />
  </div>
</template>
