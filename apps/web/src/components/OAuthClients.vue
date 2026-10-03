<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { oauthClientsApi, type OAuthClient } from '@/api';
import { useI18n } from '@/stores/i18n';
import { confirmAction } from '@/stores/dialog';
import CopyField from '@/components/ui/CopyField.vue';
const props = defineProps<{ admin?: boolean }>();
const i18n = useI18n();
const api = oauthClientsApi(props.admin);
const items = ref<OAuthClient[]>([]);
const issuer = ref('');
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const formError = ref('');
const notice = ref('');
const open = ref(false);
const credentialsOpen = ref(false);
const editing = ref<string | null>(null);
const name = ref('');
const uris = ref('');
const confidential = ref(false);
const shared = ref(false);
const secret = ref('');
const clientId = ref('');
watch(credentialsOpen, value => { if (!value) { secret.value = ''; clientId.value = ''; } });
async function load() {
  loading.value = true; error.value = '';
  try { const data = await api.list(); items.value = data.items; issuer.value = data.issuer; }
  catch { error.value = i18n.t('connect.admin_failed'); }
  finally { loading.value = false; }
}
function edit(client?: OAuthClient) {
  editing.value = client?.id ?? null; name.value = client?.name ?? '';
  uris.value = client ? (JSON.parse(client.redirectUris) as string[]).join('\n') : '';
  confidential.value = !!client?.confidential; shared.value = !!client?.shared;
  formError.value = ''; notice.value = ''; open.value = true;
}
function showCredentials(result: { id: string; clientSecret?: string }) {
  clientId.value = result.id; secret.value = result.clientSecret ?? ''; credentialsOpen.value = true;
}
async function save() {
  if (busy.value) return;
  busy.value = true; formError.value = '';
  try {
    const redirectUris = uris.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (editing.value) await api.update(editing.value, { name: name.value, redirectUris, ...(props.admin ? { shared: shared.value } : {}) });
    else showCredentials(await api.create({ name: name.value, redirectUris, confidential: confidential.value, shared: props.admin && shared.value || false }));
    open.value = false; notice.value = i18n.t('general.op-success'); await load();
  } catch { formError.value = i18n.t('oauth.save_failed'); }
  finally { busy.value = false; }
}
async function action(client: OAuthClient, kind: 'delete' | 'rotate' | 'toggle') {
  if (busy.value) return;
  if (kind !== 'toggle' && !await confirmAction(i18n.t(kind === 'delete' ? 'oauth.delete_confirm' : 'oauth.rotate_confirm'))) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    if (kind === 'delete') await api.delete(client.id);
    else if (kind === 'rotate') showCredentials(await api.rotate(client.id));
    else await api.update(client.id, { enabled: !client.enabled });
    notice.value = i18n.t('general.op-success'); await load();
  } catch { error.value = i18n.t('connect.admin_failed'); }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <section class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <h2 class="font-semibold">{{ i18n.t('oauth.my_apps') }}</h2>
      <AppButton class="btn-primary btn-sm" :disabled="busy" @click="edit()"><AppIcon name="add" />{{ i18n.t('connect.new_client') }}</AppButton>
    </div>
    <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
    <p v-if="error" class="alert alert-danger" role="alert">{{ error }} <AppButton class="btn-sm" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>
    <AppSkeleton v-if="loading" :count="2" />
    <p v-else-if="!error && !items.length" class="panel text-muted">{{ i18n.t('oauth.no_clients') }}</p>
    <div v-else-if="items.length" class="panel divide-y divide-line !py-0">
      <article v-for="client in items" :key="client.id" class="py-4 space-y-2">
        <div class="flex items-center justify-between gap-3 flex-wrap"><h3 class="font-semibold">{{ client.name }}</h3><span class="badge" :class="client.enabled ? 'badge-success' : ''">{{ i18n.t(client.enabled ? 'oauth.enabled' : 'oauth.disabled') }}</span></div>
        <CopyField :label="i18n.t('oauth.client_id')" :value="client.id" />
        <p class="text-xs text-muted">{{ i18n.t(client.confidential ? 'connect.confidential' : 'oauth.public_client') }}<span v-if="client.shared"> · {{ i18n.t('connect.shared') }}</span></p>
        <p class="text-sm break-all whitespace-pre-line">{{ (JSON.parse(client.redirectUris) as string[]).join('\n') }}</p>
        <div class="flex flex-wrap gap-2">
          <AppButton class="btn-sm" :disabled="busy" @click="edit(client)">{{ i18n.t('common.edit') }}</AppButton>
          <AppButton class="btn-sm" :disabled="busy" @click="action(client, 'toggle')">{{ i18n.t(client.enabled ? 'connect.disable' : 'connect.enable') }}</AppButton>
          <AppButton v-if="client.confidential" class="btn-sm" :disabled="busy" @click="action(client, 'rotate')">{{ i18n.t('oauth.rotate_secret') }}</AppButton>
          <AppButton class="btn-sm btn-danger" :disabled="busy" @click="action(client, 'delete')">{{ i18n.t('common.delete') }}</AppButton>
        </div>
      </article>
    </div>
    <details v-if="issuer" class="panel">
      <summary class="cursor-pointer text-sm font-medium">{{ i18n.t('oauth.endpoints') }}</summary>
      <div class="mt-4 space-y-3"><CopyField :label="i18n.t('oauth.issuer')" :value="issuer" /><CopyField :label="i18n.t('oauth.discovery')" :value="`${issuer}/.well-known/openid-configuration`" /><CopyField :label="i18n.t('oauth.authorization_endpoint')" :value="`${issuer}/authorize`" /><CopyField :label="i18n.t('oauth.token_endpoint')" :value="`${issuer}/token`" /></div>
    </details>
    <AppDialog v-model="open" :title="i18n.t(editing ? 'connect.edit_client' : 'connect.new_client')" :busy="busy">
      <AppForm class="space-y-4" @submit.prevent="save">
        <label class="block text-sm">{{ i18n.t('connect.client_name') }}<AppInput v-model="name" class="mt-1" required maxlength="100" /></label>
        <label class="block text-sm">{{ i18n.t('connect.redirect_uris') }}<AppInput v-model="uris" multiline class="mt-1 font-mono text-sm" rows="3" required /></label>
        <p class="text-xs text-muted">{{ i18n.t('oauth.redirect_help') }}</p>
        <div v-if="!editing" class="flex items-center gap-2 text-sm"><AppCheckbox v-model="confidential" :disabled="shared" :label="i18n.t('connect.confidential')" /><span>{{ i18n.t('connect.confidential') }}</span></div>
        <div v-if="admin" class="flex items-center gap-2 text-sm"><AppCheckbox v-model="shared" :disabled="confidential" :label="i18n.t('connect.shared')" /><span>{{ i18n.t('connect.shared') }}</span></div>
        <p v-if="formError" class="alert alert-danger" role="alert">{{ formError }}</p>
        <div class="flex justify-end gap-2"><AppButton :disabled="busy" @click="open = false">{{ i18n.t('common.cancel') }}</AppButton><AppButton type="submit" class="btn-primary" :loading="busy">{{ i18n.t('common.save') }}</AppButton></div>
      </AppForm>
    </AppDialog>
    <AppDialog v-model="credentialsOpen" :title="i18n.t('oauth.credentials')">
      <div class="space-y-4"><CopyField :label="i18n.t('oauth.client_id')" :value="clientId" /><template v-if="secret"><p class="text-sm text-muted">{{ i18n.t('connect.secret_once') }}</p><CopyField :label="i18n.t('oauth.client_secret')" :value="secret" /></template></div>
    </AppDialog>
  </section>
</template>
