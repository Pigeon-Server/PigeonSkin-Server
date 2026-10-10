<script setup lang="ts">
import { previewUrl, type TextureSummary } from '@/api';
import { useI18n } from '@/stores/i18n';

defineProps<{
  texture: TextureSummary;
  collected?: boolean;
  busy?: boolean;
}>();

defineEmits<{
  collect: [];
  uploader: [id: number, name?: string];
}>();

const i18n = useI18n();
</script>

<template>
  <article class="texture-card">
    <router-link :to="`/skinlib/${texture.id}`" class="preview" :aria-label="texture.name">
      <img :src="previewUrl(texture.hash)" :alt="texture.name" loading="lazy" />
      <span class="absolute left-2.5 top-2.5 badge !bg-surface/90 shadow-sm">
        {{ i18n.t(texture.kind === 'cape' ? 'general.cape' : texture.model === 'slim' ? 'skinlib.model_slim' : 'skinlib.model_classic') }}
      </span>
      <span v-if="texture.official || texture.origin === 'repost'" class="absolute bottom-2.5 left-2.5 badge !bg-surface/90 shadow-sm">
        {{ texture.official ? i18n.t('skinlib.official_resource') : i18n.t('skinlib.origin_repost') }}
      </span>
      <span
        v-if="texture.visibility === 'private'"
        class="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400 shadow-sm"
        :title="i18n.t('skinlib.private')"
      >
        <AppIcon name="lock" class="!text-sm" />
      </span>
    </router-link>
    <div class="meta">
      <router-link :to="`/skinlib/${texture.id}`" class="block">
        <h2 :title="texture.name">{{ texture.name }}</h2>
      </router-link>
      <span class="mt-1 block truncate text-[11px] text-muted">
        {{ texture.official ? i18n.t('skinlib.official_resource') : i18n.t(texture.origin === 'repost' ? 'skinlib.origin_repost' : 'skinlib.origin_original') }}
      </span>
      <div class="mt-2 flex items-center justify-between gap-2">
        <AppButton
          v-if="!texture.official"
          class="!border-0 !bg-transparent !p-0 !text-xs !font-normal text-muted min-w-0"
          :title="texture.uploaderName || i18n.t('admin.anonymous')"
          @click="$emit('uploader', texture.uploaderId || 0, texture.uploaderName ?? undefined)"
        >
          <span class="truncate hover:text-brand-600 hover:underline">{{ texture.uploaderName || i18n.t('admin.anonymous') }}</span>
        </AppButton>
        <span v-else class="truncate text-xs text-muted">{{ i18n.t('skinlib.official_resource') }}</span>

        <AppButton
          class="btn-icon"
          :class="collected ? '!text-rose-500' : 'text-muted hover:text-rose-500'"
          :aria-label="i18n.t(collected ? 'skinlib.removeFromCloset' : 'skinlib.addToCloset')"
          :aria-pressed="collected"
          :loading="busy"
          @click="$emit('collect')"
        >
          <AppIcon :name="collected ? 'favorite' : 'favorite_border'" class="!text-base" />
          <span>{{ i18n.n(texture.likes) }}</span>
        </AppButton>
      </div>
    </div>
  </article>
</template>
