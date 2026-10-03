<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from '@/stores/i18n';
import { launcherUri } from '@/lib/skin-config';
const props = defineProps<{ apiRoot?: string }>();
const i18n = useI18n();
const root = computed(() => props.apiRoot || `${location.origin}/api/yggdrasil`);
const copied = ref(false),
  busy = ref(false),
  error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await navigator.clipboard.writeText(root.value);
    copied.value = true;
    timer = setTimeout(() => {
      copied.value = false;
      busy.value = false;
    }, 1000);
  } catch {
    error.value = i18n.t('integration.copy_failed');
    busy.value = false;
  }
}
function drag(event: DragEvent) {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData('text/plain', launcherUri(root.value));
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.dropEffect = 'copy';
}
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template>
  <section class="panel !p-0 overflow-hidden">
    <header class="border-b border-line px-4 py-3">
      <h2 class="font-semibold text-sm">{{ i18n.t('integration.launcher.title') }}</h2>
    </header>
    <div class="space-y-3 p-4">
      <p class="text-sm">
        {{ i18n.t('integration.launcher.address_label') }}
        <code class="ml-2 break-all text-xs text-brand-600">{{ root }}</code>
      </p>
      <p class="text-sm text-muted">{{ i18n.t('integration.launcher.hint') }}</p>
      <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
    </div>
    <footer class="flex flex-wrap gap-2 border-t border-line bg-surface-2 px-4 py-3">
      <AppButton
        class="btn-primary"
        draggable="true"
        :disabled="busy"
        @click="copy"
        @dragstart="drag"
      >
        <AppIcon :name="copied ? 'check' : 'open_with'" />
        <span aria-live="polite">
          {{ i18n.t(copied ? 'common.copied' : 'integration.launcher.button') }}
        </span>
      </AppButton>
      <a
        class="btn"
        href="/manual/yggdrasil"
      >
        <AppIcon name="open_in_new" />
        {{ i18n.t('integration.launcher.guide') }}
      </a>
    </footer>
  </section>
</template>
