<script setup lang="ts">
import { previewUrl, type TextureSummary } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
defineProps<{ texture: TextureSummary; collected?: boolean; busy?: boolean }>();
defineEmits<{ collect: []; uploader: [id: number] }>();
const i18n = useI18n();
const session = useSessionStore();
</script>
<template>
  <article class="texture-card">
    <router-link :to="`/skinlib/${texture.id}`" class="preview" :aria-label="texture.name">
      <img :src="previewUrl(texture.hash)" :alt="texture.name" loading="lazy" />
      <span class="absolute left-3 top-3 badge !bg-surface/80">
        {{ i18n.t(texture.kind === 'cape' ? 'general.cape' : texture.model === 'slim' ? 'skinlib.model_slim' : 'skinlib.model_classic') }}
      </span>
      <span v-if="texture.official || texture.origin === 'repost'" class="absolute bottom-3 left-3 badge !bg-surface/85">
        {{ texture.official ? i18n.t('skinlib.official_resource') : i18n.t('skinlib.origin_repost') }}
      </span>
      <AppIcon
        v-if="texture.visibility === 'private'"
        name="lock"
        class="absolute right-3 top-3 !text-sm text-muted"
      />
    </router-link>
    <div class="meta">
      <router-link :to="`/skinlib/${texture.id}`">
        <h2 :title="texture.name">{{ texture.name }}</h2>
      </router-link>
      <span class="mt-1 block truncate text-[11px] text-muted">{{ texture.official ? i18n.t('skinlib.official_resource') : i18n.t(texture.origin === 'repost' ? 'skinlib.origin_repost' : 'skinlib.origin_original') }}</span>
      <div class="mt-2 flex items-center justify-between gap-2">
        <AppButton
          v-if="!texture.official"
          class="!border-0 !bg-transparent !p-0 !text-xs !font-normal text-muted min-w-0"
          @click="$emit('uploader', texture.uploaderId || 0)"
        >
          <span class="truncate">{{ texture.uploaderName || i18n.t('admin.anonymous') }}</span>
        </AppButton>
        <span v-else class="truncate text-xs text-muted">{{ i18n.t('skinlib.official_resource') }}</span>
        <AppButton
          v-if="session.user.value"
          class="btn-icon"
          :class="collected ? '!text-brand-600' : 'text-muted'"
          :aria-label="i18n.t(collected ? 'skinlib.removeFromCloset' : 'skinlib.addToCloset')"
          :aria-pressed="collected"
          :loading="busy"
          @click="$emit('collect')"
        >
          <AppIcon :name="collected ? 'favorite' : 'favorite_border'" class="!text-base" />
          {{ i18n.n(texture.likes) }}
        </AppButton>
        <span
          v-else
          class="flex items-center gap-1 text-[11px] text-muted"
          :title="i18n.t('skinlib.show.likes')"
        >
          <AppIcon name="favorite_border" class="!text-base" />
          {{ i18n.n(texture.likes) }}
        </span>
      </div>
    </div>
  </article>
</template>
