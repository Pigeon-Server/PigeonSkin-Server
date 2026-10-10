<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { connectApi, type ConnectAdmin } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { confirmAction } from '@/stores/dialog';
import CopyField from '@/components/ui/CopyField.vue';
import OAuthClients from '@/components/OAuthClients.vue';
const i18n = useI18n();
const session = useSessionStore();
const data = ref<ConnectAdmin | null>(null);
const busy = ref(false);
const error = ref('');
async function load() {
  busy.value = true; error.value = '';
  try { data.value = await connectApi.admin(); }
  catch { error.value = i18n.t('connect.admin_failed'); }
  finally { busy.value = false; }
}
async function rotate() {
  if (!await confirmAction(i18n.t('connect.rotate_confirm'))) return;
  busy.value = true; error.value = '';
  try { await connectApi.rotateKey(); await load(); }
  catch { error.value = i18n.t('connect.admin_failed'); }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('oauth.server_title')">
    <template #breadcrumb>
      <nav class="page-breadcrumb">
        <router-link to="/admin/integrations?module=oauth" class="page-back">
          <AppIcon name="arrow_back" class="!text-sm" />
          <span>{{ i18n.t('integration.title') }}</span>
        </router-link>
      </nav>
    </template>
  </PageHeader>
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }} <AppButton class="btn-sm" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>
  <AppSkeleton v-if="busy && !data" :count="2" />
  <div v-if="data" class="space-y-5">
    <section class="panel space-y-3">
      <CopyField :label="i18n.t('oauth.issuer')" :value="data.issuer" />
      <div class="flex items-center justify-between gap-3"><h2 class="font-semibold">{{ i18n.t('connect.keys') }}</h2><AppButton v-if="session.user.value?.role === 'super_admin'" class="btn-sm" :disabled="busy" @click="rotate">{{ i18n.t('connect.rotate') }}</AppButton></div>
      <p v-if="!data.keys.length" class="text-sm text-muted">{{ i18n.t('oauth.key_initialization') }}</p>
      <div v-for="key in data.keys" :key="key.kid" class="flex gap-3 flex-wrap text-sm"><code>{{ key.kid }}</code><span>{{ i18n.t(key.retiredAt ? 'connect.retired' : 'connect.active') }}</span><time>{{ i18n.d(key.createdAt) }}</time></div>
    </section>
    <OAuthClients admin />
  </div>
</template>
