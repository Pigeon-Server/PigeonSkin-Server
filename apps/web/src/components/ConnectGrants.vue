<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { connectApi, type ConnectGrant } from '@/api';
import { scopeKey } from '@/lib/oauth';
import { useI18n } from '@/stores/i18n';
import { confirmAction } from '@/stores/dialog';
const i18n = useI18n();
const items = ref<ConnectGrant[]>([]);
const error = ref('');
const loading = ref(true);
const revoking = ref('');
async function load() {
  loading.value = true; error.value = '';
  try { items.value = (await connectApi.grants()).items; }
  catch { error.value = i18n.t('common.network'); }
  finally { loading.value = false; }
}
async function revoke(id: string) {
  if (revoking.value || !await confirmAction(i18n.t('connect.revoke_confirm'))) return;
  revoking.value = id;
  try { await connectApi.revoke(id); await load(); }
  catch { error.value = i18n.t('common.network'); }
  finally { revoking.value = ''; }
}
onMounted(load);
</script>
<template>
  <section class="space-y-4">
    <p v-if="error" class="alert alert-danger" role="alert">{{ error }} <AppButton class="btn-sm" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>
    <AppSkeleton v-if="loading" :count="2" />
    <p v-else-if="!items.length && !error" class="panel text-muted">{{ i18n.t('connect.no_apps') }}</p>
    <div v-else class="panel divide-y divide-line !py-0">
      <article v-for="item in items" :key="item.id" class="py-4 flex justify-between gap-4">
        <div class="min-w-0 space-y-2">
          <p class="font-semibold">{{ item.clientName }}<span v-if="item.playerName" class="text-sm text-muted ml-2">{{ item.playerName }}</span></p>
          <p class="text-xs text-muted">{{ i18n.t('oauth.authorization_dates', { granted: i18n.d(item.createdAt), expires: i18n.d(item.expiresAt) }) }}</p>
          <ul class="text-sm space-y-1"><li v-for="scope in JSON.parse(item.scopes) as string[]" :key="scope" class="flex gap-2"><AppIcon name="check" class="text-muted shrink-0" />{{ i18n.t(scopeKey(scope)) }}</li></ul>
        </div>
        <AppButton class="btn-sm shrink-0 self-start" :loading="revoking === item.id" :disabled="!!revoking" @click="revoke(item.id)">{{ i18n.t('connect.revoke') }}</AppButton>
      </article>
    </div>
  </section>
</template>
