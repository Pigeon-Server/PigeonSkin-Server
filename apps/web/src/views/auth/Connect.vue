<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, connectApi, type ConnectAuthorization } from '@/api';
import { scopeKey } from '@/lib/oauth';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
const route = useRoute();
const i18n = useI18n();
const session = useSessionStore();
const device = computed(() => route.path === '/connect/device');
const code = ref(String(route.query.user_code || ''));
const data = ref<ConnectAuthorization | null>(null);
const playerId = ref<number | null>(null);
const loading = ref(false);
const error = ref('');
const done = ref(false);
const selectRequired = computed(() => data.value?.scopes.includes('Yggdrasil.PlayerProfiles.Select') === true);
const canApprove = computed(() => !!data.value && (!selectRequired.value || playerId.value !== null));
async function load() {
  loading.value = true; error.value = ''; data.value = null;
  try {
    data.value = device.value ? await connectApi.device(code.value) : await connectApi.interaction(String(route.params.id));
    playerId.value = data.value.profiles.length === 1 ? data.value.profiles[0]!.playerId : null;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'login_required') window.location.assign(`/login?redirect=${encodeURIComponent(route.fullPath)}`);
    else error.value = i18n.t('connect.expired');
  }
  finally { loading.value = false; }
}
async function submit(approve: boolean) {
  if (!data.value || (approve && !canApprove.value)) return;
  loading.value = true; error.value = '';
  try {
    if (device.value) {
      await connectApi.confirmDevice(code.value, data.value.ticket!, approve, selectRequired.value ? playerId.value : null);
      done.value = true;
    } else {
      const result = await connectApi.approve(String(route.params.id), approve, selectRequired.value ? playerId.value : null);
      window.location.assign(result.redirect);
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'login_required') window.location.assign(`/login?redirect=${encodeURIComponent(route.fullPath)}`);
    else error.value = i18n.t(e instanceof ApiError && e.code === 'access_denied' ? 'oauth.scope_denied' : 'connect.expired');
  }
  finally { loading.value = false; }
}
onMounted(() => { if (!device.value || code.value) void load(); });
</script>
<template>
  <div class="space-y-5">
    <h1>{{ i18n.t(device ? 'connect.device_title' : 'connect.authorize_title') }}</h1>
    <p v-if="done" class="alert alert-success" role="status">{{ i18n.t('connect.device_done') }}</p>
    <template v-else>
      <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
      <AppForm v-if="device && !data" class="space-y-3" @submit.prevent="load">
        <label for="device-code" class="block">{{ i18n.t('connect.device_code') }}</label>
        <AppInput id="device-code" v-model="code" class="uppercase" maxlength="20" autocomplete="off" required />
        <AppButton type="submit" class="btn-primary" :disabled="loading">{{ i18n.t('connect.continue') }}</AppButton>
      </AppForm>
      <AppSkeleton v-if="loading && !data" :count="2" />
      <template v-if="data">
        <p class="text-lg font-semibold">{{ data.client.name }}</p>
        <p v-if="session.user.value" class="text-sm text-muted break-words">{{ i18n.t('oauth.authorizing_as', { name: session.user.value.nickname, email: session.user.value.email }) }}</p>
        <p v-if="device" class="font-mono text-lg tracking-widest">{{ code }}</p>
        <p class="text-sm text-muted">{{ i18n.t('connect.requests') }}</p>
        <ul class="space-y-2 list-disc pl-5">
          <li v-for="scope in data.scopes" :key="scope">{{ i18n.t(scopeKey(scope)) }}</li>
        </ul>
        <div v-if="selectRequired">
          <label for="connect-player" class="block mb-2">{{ i18n.t('connect.choose_player') }}</label>
          <AppSelect id="connect-player" v-model="playerId" :options="[{ value: '', label: i18n.t('connect.choose_player'), disabled: true }, ...data.profiles.map(profile => ({ value: profile.playerId, label: profile.name }))]" :aria-label="i18n.t('connect.choose_player')" />
          <router-link v-if="!data.profiles.length" to="/player" class="btn mt-3">{{ i18n.t('player.create') }}</router-link>
        </div>
        <div class="flex gap-3">
          <AppButton class="btn-primary" :disabled="loading || !canApprove" @click="submit(true)">{{ i18n.t('connect.allow') }}</AppButton>
          <AppButton :disabled="loading" @click="submit(false)">{{ i18n.t('connect.deny') }}</AppButton>
        </div>
      </template>
    </template>
  </div>
</template>
