<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { pigeonApi, type PigeonKeyItem } from '@/api';
import { useI18n } from '@/stores/i18n';
import { confirmAction } from '@/stores/dialog';
import CopyField from '@/components/ui/CopyField.vue';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n();
const items = ref<PigeonKeyItem[]>([]), page = ref(1), totalPages = ref(1), label = ref(''), scopes = ref(['players.read', 'users.read']), secret = ref(''), error = ref(''), busy = ref(false);
async function load() { const result = await pigeonApi.keys(page.value); items.value = result.items; totalPages.value = result.totalPages; }
async function perform(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await action(); await load(); }
  catch (e) { error.value = apiErrorMessage(e); }
  finally { busy.value = false; }
}
async function create() { await perform(async () => { secret.value = (await pigeonApi.create(label.value, scopes.value)).secret; label.value = ''; }); }
async function rotate(id: string) { if (await confirmAction(i18n.t('pigeon.rotate_confirm'))) await perform(async () => { secret.value = (await pigeonApi.rotate(id)).secret; }); }
async function revoke(id: string) { if (await confirmAction(i18n.t('pigeon.revoke_confirm'))) await perform(() => pigeonApi.revoke(id)); }
async function move(delta: number) { page.value += delta; await perform(load); }
const scopeNames: Record<string, string> = { 'players.read': 'players', 'users.read': 'users', 'users.email': 'email', 'admin.texture.import': 'texture_import', 'admin.users.write': 'users_write', 'admin.textures.write': 'textures_write', 'admin.stats.read': 'stats_read', 'admin.settings.write': 'settings_write' };
onMounted(() => perform(load));
</script>
<template>
  <PageHeader :title="i18n.t('pigeon.title')">
    <template #breadcrumb>
      <nav class="page-breadcrumb">
        <router-link to="/admin/integrations?module=pigeon" class="page-back">
          <AppIcon name="arrow_back" class="!text-sm" />
          <span>{{ i18n.t('pigeon.settings') }}</span>
        </router-link>
      </nav>
    </template>
  </PageHeader>
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
  <section v-if="secret" class="panel space-y-3" aria-live="polite"><p>{{ i18n.t('pigeon.secret_once') }}</p><CopyField :label="i18n.t('pigeon.secret')" :value="secret" /><AppButton @click="secret = ''">{{ i18n.t('common.close') }}</AppButton></section>
  <AppForm class="panel space-y-4" @submit.prevent="create">
    <h2 class="text-lg font-semibold">{{ i18n.t('pigeon.create') }}</h2>
    <label class="block">{{ i18n.t('pigeon.label') }}<AppInput v-model="label" class="mt-2" required maxlength="100" /></label>
    <fieldset class="space-y-2"><legend class="mb-2">{{ i18n.t('pigeon.permissions') }}</legend><AppCheckboxGroup v-model="scopes" class="grid gap-2" :options="Object.keys(scopeNames).map(scope => ({ value: scope, label: i18n.t(`pigeon.scopes.${scopeNames[scope]}`) }))" /></fieldset>
    <AppButton type="submit" class="btn-primary" :disabled="busy || !scopes.length">{{ i18n.t('pigeon.create') }}</AppButton>
  </AppForm>
  <section class="panel overflow-x-auto">
    <p v-if="!items.length" class="text-muted">{{ i18n.t('pigeon.empty') }}</p>
    <table v-else class="w-full text-sm"><thead><tr><th>{{ i18n.t('pigeon.label') }}</th><th>{{ i18n.t('pigeon.permissions') }}</th><th>{{ i18n.t('pigeon.usage') }}</th><th>{{ i18n.t('pigeon.last_used') }}</th><th>{{ i18n.t('pigeon.actions') }}</th></tr></thead><tbody>
      <tr v-for="key in items" :key="key.id" class="border-t border-line"><td class="py-4"><strong>{{ key.label }}</strong><p class="text-xs text-muted">{{ key.prefix }}…</p><span class="badge">{{ i18n.t(key.revokedAt ? 'pigeon.revoked' : key.enabled ? 'common.enabled' : 'common.disabled') }}</span></td><td><p v-for="scope in JSON.parse(key.scopes)" :key="scope">{{ i18n.t(`pigeon.scopes.${scopeNames[scope]}`) }}</p></td><td>{{ key.usageCount }}</td><td>{{ key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : i18n.t('pigeon.never') }}</td><td><div v-if="!key.revokedAt" class="flex gap-2 flex-wrap"><AppButton :disabled="busy" @click="perform(() => pigeonApi.update(key.id, !key.enabled))">{{ i18n.t(key.enabled ? 'pigeon.disable' : 'pigeon.enable') }}</AppButton><AppButton :disabled="busy" @click="rotate(key.id)">{{ i18n.t('pigeon.rotate') }}</AppButton><AppButton :disabled="busy" @click="revoke(key.id)">{{ i18n.t('pigeon.revoke') }}</AppButton></div></td></tr>
    </tbody></table>
  </section>
  <div v-if="totalPages > 1" class="flex gap-4 justify-center"><AppButton :disabled="page === 1 || busy" @click="move(-1)">{{ i18n.t('votes.previous') }}</AppButton><span>{{ page }} / {{ totalPages }}</span><AppButton :disabled="page >= totalPages || busy" @click="move(1)">{{ i18n.t('votes.next') }}</AppButton></div>
</template>
