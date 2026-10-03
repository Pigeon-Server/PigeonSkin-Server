<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { adminApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { confirmAction } from '@/stores/dialog';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const session = useSessionStore();
const data = ref<Awaited<ReturnType<typeof adminApi.update>> | null>(null);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const available = computed(() => {
  if (!data.value?.latest) return false;
  const a = data.value.latest.version.split('-')[0]!.split('.').map(Number);
  const b = data.value.current.split('-')[0]!.split('.').map(Number);
  for (let n = 0; n < 3; n++) {
    if (a[n] !== b[n]) return a[n]! > b[n]!;
  }
  return false;
});
async function load() {
  busy.value = true;
  error.value = '';
  try {
    data.value = await adminApi.update();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function deploy() {
  if (!(await confirmAction(i18n.t('admin.update_deploy')))) return;
  busy.value = true;
  error.value = '';
  try {
    await adminApi.deployUpdate();
    notice.value = i18n.t('admin.update_triggered');
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('general.check-update')">
    <AppButton :loading="busy" @click="load">
      <AppIcon name="refresh" />
      {{ i18n.t('admin.update_check') }}
    </AppButton>
  </PageHeader>
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
  <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
  <section v-if="data" class="panel max-w-3xl">
    <div class="flex gap-12 mb-6">
      <div>
        <p class="text-muted text-xs">{{ i18n.t('admin.update_current') }}</p>
        <p class="text-3xl font-semibold mt-2">{{ data.current }}</p>
      </div>
      <div v-if="data.latest">
        <p class="text-muted text-xs">{{ i18n.t('admin.update_latest') }}</p>
        <p class="text-3xl font-semibold mt-2">{{ data.latest.version }}</p>
      </div>
    </div>
    <p v-if="data.latest" class="badge badge-success mb-4">
      {{ i18n.t(available ? 'admin.update_available' : 'admin.update_up_to_date') }}
    </p>
    <MarkdownContent v-if="data.latest" :content="data.latest.notes" />
    <p v-else class="text-muted mb-4">{{ i18n.t('admin.update_manifest_unconfigured') }}</p>
    <AppButton
      v-if="data.deployConfigured && session.user.value?.role === 'super_admin'"
      class="btn-primary mt-5"
      :loading="busy"
      @click="deploy"
    >
      <AppIcon name="system_update_alt" />
      {{ i18n.t('admin.update_deploy') }}
    </AppButton>
    <p v-else-if="!data.deployConfigured" class="text-muted text-sm mt-4">
      {{ i18n.t('admin.update_unconfigured') }}
    </p>
  </section>
</template>
