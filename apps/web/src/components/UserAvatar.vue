<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { textureApi, userAvatarUrl } from '@/api';
import AvatarPreview from '@/components/AvatarPreview.vue';
const props = defineProps<{ textureId: number | null; name: string; userId?: number | null }>();
const hash = ref<string | null>(null);
const cacheVersion = ref(Date.now());
const source = computed(() => props.userId ? `${userAvatarUrl(props.userId, { version: props.textureId || 0 })}&refresh=${cacheVersion.value}` : undefined);
let generation = 0;
watch(() => [props.textureId, props.userId] as const, async ([id, userId]) => {
  const current = ++generation;
  cacheVersion.value = Date.now();
  hash.value = null;
  if (!id || userId) return;
  try { const texture = await textureApi.get(id); if (current === generation && texture.kind === 'skin') hash.value = texture.hash; }
  catch { if (current === generation) hash.value = null; }
}, { immediate: true });
</script>
<template><AvatarPreview :hash="hash" :name="name" :user-id="userId" :src="source" /></template>
