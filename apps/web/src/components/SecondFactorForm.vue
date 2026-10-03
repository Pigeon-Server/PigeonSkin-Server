<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue';
import { startAuthentication } from '@simplewebauthn/browser';
import type { SecurityChallenge, SecondFactor } from '@pigeon-skin/shared/security';
import { securityApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import { passkeysSupported, securityError } from '@/lib/security';

defineProps<{ reauth?: boolean }>();
const emit = defineEmits<{ complete: [redirect: string]; restart: [] }>();
const i18n = useI18n();
const info = ref<SecurityChallenge | null>(null);
const method = ref<SecondFactor>('totp');
const code = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);
const expired = ref(false);
const sentAt = ref(0);
const now = ref(Date.now());
const timer = window.setInterval(() => { now.value = Date.now(); }, 1000);
onUnmounted(() => window.clearInterval(timer));
const supported = passkeysSupported();
const methods = computed(() => info.value?.methods ?? []);
async function load() {
  error.value = '';
  try {
    info.value = await securityApi.challenge();
    method.value = info.value.methods.find(m => m !== 'recovery' && (m !== 'passkey' || supported)) ?? info.value.methods[0] ?? 'recovery';
    code.value = ''; sentAt.value = 0;
  } catch (e) { error.value = i18n.t(securityError(e)); expired.value = true; }
}
onMounted(load);
async function send() {
  busy.value = true; error.value = ''; notice.value = '';
  try { await securityApi.sendEmail(); sentAt.value = Date.now(); notice.value = i18n.t('security.code_sent'); }
  catch (e) { error.value = i18n.t(securityError(e)); }
  finally { busy.value = false; }
}
async function submit() {
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const response = method.value === 'passkey' ? await startAuthentication({ optionsJSON: await securityApi.authenticationOptions() }) : undefined;
    const result = await securityApi.verify(method.value, code.value, response);
    code.value = '';
    if (result.requiresTwoFactor) { await load(); notice.value = i18n.t('security.next_account'); }
    else emit('complete', result.redirect ?? '/user');
  } catch (e) {
    const key = securityError(e); error.value = i18n.t(key);
    if (key === 'security.challenge_expired') expired.value = true;
  } finally { busy.value = false; }
}
</script>

<template>
  <AppForm class="space-y-4" @submit.prevent="submit">
    <template v-if="info && !expired">
      <p class="text-sm text-muted">{{ i18n.t('security.verify_account', { account: info.account }) }}</p>
      <div>
        <label for="second-factor-method" class="mb-1 block text-sm font-medium">{{ i18n.t('security.method') }}</label>
        <AppSelect id="second-factor-method" v-model="method" :options="methods.map(item => ({ value: item, label: i18n.t(`security.${item}`) }))" :disabled="busy" @change="code = ''; notice = ''" />
      </div>
      <template v-if="method !== 'passkey'">
        <p v-if="method === 'email'" class="text-sm text-muted">{{ info.email }}</p>
        <AppButton v-if="method === 'email'" class="btn-sm" :disabled="busy || now - sentAt < 60000" @click="send">{{ i18n.t('security.send_code') }}</AppButton>
        <label for="second-factor-code" class="block text-sm font-medium">{{ i18n.t(method === 'recovery' ? 'security.recovery' : 'security.code') }}</label>
        <AppInput id="second-factor-code" v-model="code" :inputmode="method === 'recovery' ? 'text' : 'numeric'" autocomplete="one-time-code" :maxlength="method === 'recovery' ? 128 : 6" required :disabled="busy" />
      </template>
      <p v-else-if="!supported" class="text-sm text-muted">{{ i18n.t('security.browser_unavailable') }}</p>
      <AppButton class="btn-primary w-full" type="submit" :loading="busy" :disabled="method === 'passkey' && !supported">{{ i18n.t('security.verify') }}</AppButton>
    </template>
    <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
    <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
    <AppButton v-if="expired && reauth" class="btn" @click="emit('restart')">{{ i18n.t('security.verify_identity') }}</AppButton>
    <router-link v-else-if="expired" to="/login" class="btn">{{ i18n.t('security.restart_login') }}</router-link>
  </AppForm>
</template>
