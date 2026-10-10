<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { startRegistration } from '@simplewebauthn/browser';
import QRCode from 'qrcode';
import type { SecurityStatus } from '@pigeon-skin/shared/security';
import { securityApi, oauthApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useSessionStore } from '@/stores/session';
import { confirmAction } from '@/stores/dialog';
import { securityError, passkeysSupported } from '@/lib/security';
import SecondFactorForm from './SecondFactorForm.vue';

// heading 为 false 时只保留状态徽标：作为独立页面内容时，标题由页面页头承担。
const props = withDefaults(defineProps<{ heading?: boolean }>(), { heading: true });
const emit = defineEmits<{ status: [enabled: boolean] }>();
const i18n = useI18n(), session = useSessionStore();
const data = ref<SecurityStatus | null>(null);
const busy = ref(false), loading = ref(true), error = ref(''), notice = ref('');
const password = ref(''), verifying = ref(false);
const providers = ref<Array<{ provider: string }>>([]);
const enrollment = ref<'email' | 'totp' | 'change-email' | ''>('');
const code = ref(''), secret = ref(''), qr = ref('');
const keyName = ref(''), email = ref('');
const recoveryCodes = ref<string[]>([]);
const supported = passkeysSupported();
const reauthDestination = `${location.pathname === '/account/security' ? '/account/security' : '/profile'}?security_reauth=1`;
const methodCount = computed(() => data.value ? Number(data.value.email) + Number(data.value.totp) + data.value.passkeys.length : 0);
async function load() {
  try { data.value = await securityApi.status(); emit('status', data.value.enabled); }
  catch (e) { error.value = i18n.t(securityError(e)); }
  finally { loading.value = false; }
}
onMounted(async () => {
  await load();
  if (data.value && !data.value.hasPassword) {
    try { providers.value = (await oauthApi.my()).bindings; }
    catch (e) { error.value = i18n.t(securityError(e)); }
  }
});
async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await action(); await load(); }
  catch (e) { error.value = i18n.t(securityError(e)); }
  finally { busy.value = false; }
}
async function reauth() {
  await run(async () => {
    const result = await securityApi.reauth(password.value);
    password.value = ''; verifying.value = result.requiresTwoFactor;
    if (!verifying.value) notice.value = i18n.t('security.verified');
  });
}
async function reauthenticated() {
  verifying.value = false; notice.value = i18n.t('security.verified'); await load();
}
async function enroll(method: 'email' | 'totp') {
  await run(async () => {
    const result = await securityApi.begin(method);
    enrollment.value = method; code.value = ''; secret.value = result.secret ?? '';
    qr.value = result.uri ? await QRCode.toDataURL(result.uri, { width: 224, margin: 2 }) : '';
    if (method === 'email') notice.value = i18n.t('security.code_sent');
  });
}
async function confirmEnrollment() {
  if (!enrollment.value) return;
  await run(async () => {
    const result = await securityApi.confirm(enrollment.value as 'email' | 'totp' | 'change-email', code.value);
    recoveryCodes.value = result.recoveryCodes;
    enrollment.value = ''; secret.value = ''; qr.value = ''; code.value = '';
    await session.fetchSession(true);
    notice.value = i18n.t('general.op-success');
  });
}
async function registerKey() {
  await run(async () => {
    const response = await startRegistration({ optionsJSON: await securityApi.registrationOptions() });
    const result = await securityApi.registerPasskey(keyName.value.trim(), response);
    recoveryCodes.value = result.recoveryCodes; keyName.value = ''; enrollment.value = '';
    notice.value = i18n.t('general.op-success');
  });
}
async function disable() {
  if (!await confirmAction(i18n.t('security.disable_confirm'))) return;
  await run(async () => { await securityApi.disable(); recoveryCodes.value = []; enrollment.value = ''; secret.value = ''; qr.value = ''; notice.value = i18n.t('general.op-success'); });
}
async function remove(method: 'email' | 'totp' | 'passkey', id?: string) {
  if (methodCount.value === 1) return disable();
  if (!await confirmAction(i18n.t('security.remove_confirm'))) return;
  await run(async () => { await securityApi.remove(method, id); enrollment.value = ''; notice.value = i18n.t('general.op-success'); });
}
async function regenerate() {
  if (!await confirmAction(i18n.t('security.regenerate_confirm'))) return;
  await run(async () => { recoveryCodes.value = (await securityApi.recovery()).recoveryCodes; enrollment.value = ''; });
}
async function changeEmail() {
  await run(async () => { await securityApi.changeEmail(email.value); enrollment.value = 'change-email'; code.value = ''; notice.value = i18n.t('security.code_sent'); });
}
async function copyCodes() {
  await run(async () => { await navigator.clipboard.writeText(recoveryCodes.value.join('\n')); notice.value = i18n.t('security.copied'); });
}
function downloadCodes() {
  const url = URL.createObjectURL(new Blob([recoveryCodes.value.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'recovery-codes.txt'; anchor.click(); URL.revokeObjectURL(url);
}
</script>

<template>
  <section class="panel space-y-4">
    <div class="flex items-center gap-3" :class="props.heading ? 'justify-between' : 'justify-end'">
      <h2 v-if="props.heading" class="font-semibold">{{ i18n.t('security.title') }}</h2>
      <span v-if="data" class="badge" :class="data.enabled ? 'badge-success' : 'badge-default'">{{ i18n.t(data.enabled ? 'security.enabled' : 'security.disabled') }}</span>
    </div>
    <p class="text-sm text-muted">{{ i18n.t('security.launcher_notice') }}</p>
    <p v-if="loading" role="status">{{ i18n.t('common.loading') }}</p>
    <AppButton v-else-if="!data" class="btn" @click="load">{{ i18n.t('common.retry') }}</AppButton>
    <template v-if="data">
      <div v-if="!data.reauthenticated" class="rounded-lg border border-line p-4 space-y-3">
        <p class="text-sm">{{ i18n.t('security.reauth_notice') }}</p>
        <SecondFactorForm v-if="verifying" reauth @complete="reauthenticated" @restart="verifying = false" />
        <AppForm v-else-if="data.enabled || data.hasPassword" class="space-y-3" @submit.prevent="reauth">
          <label v-if="!data.enabled" for="security-password" class="block text-sm font-medium">{{ i18n.t('auth.password') }}</label>
          <AppInput v-if="!data.enabled" id="security-password" v-model="password" type="password" autocomplete="current-password" required />
          <AppButton class="btn" type="submit" :loading="busy">{{ i18n.t('security.verify_identity') }}</AppButton>
        </AppForm>
        <div v-else class="flex flex-wrap gap-2">
          <a v-for="provider in providers" :key="provider.provider" class="btn" :href="`/auth/oauth/${encodeURIComponent(provider.provider)}?redirect=${encodeURIComponent(reauthDestination)}`">{{ i18n.t('security.reauth_provider', { provider: provider.provider }) }}</a>
        </div>
      </div>
      <p v-else class="text-sm text-muted">{{ i18n.t('security.verified') }}</p>
      <div class="space-y-3">
        <div class="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
          <div><p class="font-medium">{{ i18n.t('security.email') }}</p><p class="text-xs text-muted">{{ i18n.t(data.email ? 'security.bound' : data.emailAvailable ? 'security.not_bound' : 'security.email_unavailable') }}</p></div>
          <AppButton class="btn-sm" :disabled="busy || !data.reauthenticated || (!data.email && !data.emailAvailable)" @click="data.email ? remove('email') : enroll('email')">{{ i18n.t(data.email ? 'security.remove' : 'security.bind') }}</AppButton>
        </div>
        <div class="flex items-center justify-between gap-3 rounded-lg border border-line p-3">
          <div><p class="font-medium">{{ i18n.t('security.totp') }}</p><p class="text-xs text-muted">{{ i18n.t(data.totp ? 'security.bound' : data.totpAvailable ? 'security.not_bound' : 'security.totp_unavailable') }}</p></div>
          <AppButton class="btn-sm" :disabled="busy || !data.reauthenticated || (!data.totp && !data.totpAvailable)" @click="data.totp ? remove('totp') : enroll('totp')">{{ i18n.t(data.totp ? 'security.remove' : 'security.bind') }}</AppButton>
        </div>
        <div class="rounded-lg border border-line p-3 space-y-3">
          <p class="font-medium">{{ i18n.t('security.passkey') }}</p>
          <div v-for="key in data.passkeys" :key="key.id" class="flex items-center justify-between gap-3">
            <span class="break-all text-sm">{{ key.name }}</span>
            <AppButton class="btn-sm" :disabled="busy || !data.reauthenticated" @click="remove('passkey', key.id)">{{ i18n.t('security.remove') }}</AppButton>
          </div>
          <AppForm v-if="data.passkeysAvailable && supported" class="flex flex-wrap gap-2" @submit.prevent="registerKey">
            <label for="passkey-name" class="sr-only">{{ i18n.t('security.key_name') }}</label>
            <AppInput id="passkey-name" v-model="keyName" class="min-w-0 flex-1" maxlength="100" required :placeholder="i18n.t('security.key_name')" :disabled="busy || !data.reauthenticated" />
            <AppButton type="submit" class="btn" :disabled="busy || !data.reauthenticated">{{ i18n.t('security.add_key') }}</AppButton>
          </AppForm>
          <p v-else class="text-xs text-muted">{{ i18n.t('security.browser_unavailable') }}</p>
        </div>
      </div>
      <AppForm v-if="enrollment" class="space-y-3 rounded-lg border border-line p-4" @submit.prevent="confirmEnrollment">
        <h3 class="font-medium">{{ i18n.t(enrollment === 'change-email' ? 'security.change_email' : `security.${enrollment}`) }}</h3>
        <template v-if="enrollment === 'totp'">
          <p class="text-sm text-muted">{{ i18n.t('security.scan_qr') }}</p>
          <img v-if="qr" :src="qr" :alt="i18n.t('security.totp_qr')" width="224" height="224" />
          <p class="break-all font-mono text-sm select-all">{{ secret }}</p>
        </template>
        <AppButton v-else class="btn-sm" :disabled="busy" @click="run(() => securityApi.resend(enrollment as 'email' | 'change-email'))">{{ i18n.t('security.send_code') }}</AppButton>
        <label for="enrollment-code" class="block text-sm font-medium">{{ i18n.t('security.code') }}</label>
        <AppInput id="enrollment-code" v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required :disabled="busy" />
        <AppButton type="submit" class="btn-primary" :loading="busy">{{ i18n.t('security.verify') }}</AppButton>
        <AppButton class="btn ml-2" :disabled="busy" @click="enrollment = ''; secret = ''; qr = ''; code = ''">{{ i18n.t('common.cancel') }}</AppButton>
      </AppForm>
      <div v-if="data.enabled" class="space-y-3">
        <h3 class="font-medium">{{ i18n.t('security.recovery') }}</h3>
        <p class="text-sm text-muted">{{ i18n.t('security.recovery_remaining', { count: data.recoveryRemaining }) }}</p>
        <AppButton class="btn" :disabled="busy || !data.reauthenticated" @click="regenerate">{{ i18n.t('security.regenerate') }}</AppButton>
        <AppForm class="space-y-2" @submit.prevent="changeEmail">
          <label for="security-new-email" class="block text-sm font-medium">{{ i18n.t('security.change_email') }}</label>
          <div class="flex flex-wrap gap-2">
            <AppInput id="security-new-email" v-model="email" type="email" autocomplete="email" class="min-w-0 flex-1" required :disabled="busy || !data.reauthenticated" />
            <AppButton type="submit" class="btn" :disabled="busy || !data.reauthenticated || !data.mailAvailable">{{ i18n.t('security.send_code') }}</AppButton>
          </div>
        </AppForm>
        <AppButton class="btn-danger" :disabled="busy || !data.reauthenticated" @click="disable">{{ i18n.t('security.disable') }}</AppButton>
      </div>
    </template>
    <div v-if="recoveryCodes.length" class="rounded-lg border border-line p-4 space-y-3">
      <h3 class="font-semibold">{{ i18n.t('security.save_recovery') }}</h3>
      <p class="text-sm text-muted">{{ i18n.t('security.recovery_notice') }}</p>
      <ul class="space-y-1 font-mono text-xs"><li v-for="item in recoveryCodes" :key="item" class="break-all select-all">{{ item }}</li></ul>
      <div class="flex flex-wrap gap-2">
        <AppButton class="btn" @click="copyCodes">{{ i18n.t('security.copy') }}</AppButton>
        <AppButton class="btn" @click="downloadCodes">{{ i18n.t('security.download') }}</AppButton>
        <AppButton class="btn" @click="recoveryCodes = []">{{ i18n.t('security.saved') }}</AppButton>
      </div>
    </div>
    <p v-if="notice" class="alert alert-success" role="status">{{ notice }}</p>
    <p v-if="error" class="alert alert-danger" role="alert">{{ error }}</p>
  </section>
</template>
