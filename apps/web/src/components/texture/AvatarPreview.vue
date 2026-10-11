<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { avatarUrl, textureUrl } from '@/api';
import { defaultAvatarModel, defaultAvatarUrls } from '@pigeon-skin/shared/default-skins';
const props = withDefaults(defineProps<{ hash?: string | null | undefined; name: string; userId?: number | null | undefined; src?: string | undefined; mode?: '2d' | '3d' }>(), { mode: '2d' });
const placeholder = computed(() => defaultAvatarUrls[defaultAvatarModel(props.userId)][props.mode]);
const source = ref('');
let generation = 0;
let fallbackUsed = false;
watch(() => [props.hash, props.src, props.userId, props.mode], () => {
  generation++; fallbackUsed = false;
  source.value = props.src || (props.hash ? avatarUrl(props.hash, { size: 100, mode: props.mode }) : placeholder.value);
}, { immediate: true });
async function fallback() {
  if (fallbackUsed || !props.hash) { source.value = placeholder.value; return; }
  fallbackUsed = true;
  const current = generation;
  try {
    const { renderSkinAvatar } = await import('@/lib/avatar-renderer');
    const rendered = await renderSkinAvatar(textureUrl(props.hash), 100, props.mode);
    if (current === generation) source.value = rendered;
  } catch { if (current === generation) source.value = placeholder.value; }
}
</script>
<template><img :src="source" :alt="name" loading="lazy" class="object-contain" style="image-rendering:pixelated" @error="fallback" /></template>
