<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@/stores/i18n';
import AppTooltip from '@/components/ui/AppTooltip.vue';

const props = withDefaults(defineProps<{ muted?: boolean; closeable?: boolean; canManage?: boolean; hasVoice?: boolean }>(), { muted: false, closeable: false, canManage: false, hasVoice: true });
const emit = defineEmits<{ action: []; mute: []; capture: []; zoom: [delta: number]; reset: []; hide: []; manage: [] }>();
const i18n = useI18n();
const tools = computed(() => [
  { label: props.hasVoice ? 'live2d.play_motion' : 'live2d.play_motion_only', icon: 'chat_bubble_outline', action: () => emit('action') },
  ...(props.hasVoice ? [{ label: props.muted ? 'live2d.unmute' : 'live2d.mute', icon: props.muted ? 'volume_off' : 'volume_up', action: () => emit('mute') }] : []),
  ...(props.canManage ? [{ label: 'live2d.choose_model', icon: 'person_search', action: () => emit('manage') }] : []),
  { label: 'live2d.capture', icon: 'photo_camera', action: () => emit('capture') },
  { label: 'live2d.zoom_in', icon: 'add', action: () => emit('zoom', 0.1) },
  { label: 'live2d.zoom_out', icon: 'remove', action: () => emit('zoom', -0.1) },
  { label: 'live2d.reset', icon: 'restart_alt', action: () => emit('reset') },
  ...(props.closeable ? [{ label: 'live2d.hide', icon: 'close', action: () => emit('hide') }] : []),
]);
</script>

<template>
  <div class="live2d-toolbar" role="group" :aria-label="i18n.t('live2d.controls')">
    <AppTooltip v-for="tool in tools" :key="tool.label" :text="i18n.t(tool.label)" v-slot="{ attrs }">
      <button v-bind="attrs" type="button" class="live2d-tool" :aria-label="i18n.t(tool.label)" @click="tool.action">
        <AppIcon :name="tool.icon" />
      </button>
    </AppTooltip>
  </div>
</template>

<style scoped>
.live2d-toolbar { display: flex; flex-direction: column; gap: 5px; }
.live2d-tool { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 6px; color: var(--v0-muted); background: transparent; cursor: pointer; transition: color 0.25s, background 0.25s, transform 0.25s; }
.live2d-tool :deep(.material-icons) { font-size: 24px; }
.live2d-tool:hover, .live2d-tool:focus-visible { color: var(--brand); background: color-mix(in srgb, var(--v0-surface) 90%, transparent); transform: translateX(-2px); }
.live2d-tool:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .live2d-tool { transition: none; } }
</style>
