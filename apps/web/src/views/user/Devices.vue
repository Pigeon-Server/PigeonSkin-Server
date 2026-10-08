// 登录设备管理：列出自己全部已登录的浏览器会话与游戏启动器令牌，
// 可逐个踢除。踢掉当前浏览器会话后跳登录页。
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, type BrowserDevice, type LauncherDevice } from '@/api';
import { useSessionStore } from '@/stores/session';
import { useI18n } from '@/stores/i18n';
import { confirmAction } from '@/stores/dialog';
import { apiErrorMessage } from '@/lib/api-error';

const router = useRouter();
const session = useSessionStore();
const i18n = useI18n();

const browserDevices = ref<BrowserDevice[]>([]);
const launcherDevices = ref<LauncherDevice[]>([]);
const loading = ref(true);
const busyId = ref('');
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.devices();
    browserDevices.value = data.browser;
    launcherDevices.value = data.launcher;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

/** 浏览器设备的可读名：从 UA 提取浏览器与操作系统摘要 */
function describeBrowser(ua: string | null): string {
  if (!ua) return i18n.t('devices.unknown_device');
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari' : i18n.t('devices.unknown_browser');
  const os = /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
      : /Android/.test(ua) ? 'Android'
        : /iPhone|iPad/.test(ua) ? 'iOS'
          : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

async function revokeSession(device: BrowserDevice) {
  const message = device.current ? i18n.t('devices.revoke_current_confirm') : i18n.t('devices.revoke_confirm');
  if (!await confirmAction(message)) return;
  busyId.value = device.id;
  error.value = '';
  try {
    const result = await api.revokeDeviceSession(device.id);
    if (result.current) {
      await session.fetchSession();
      void router.push('/login');
      return;
    }
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busyId.value = '';
  }
}

async function revokeLauncher(device: LauncherDevice) {
  if (!await confirmAction(i18n.t('devices.revoke_launcher_confirm', { player: device.playerName }))) return;
  busyId.value = device.id;
  error.value = '';
  try {
    await api.revokeDeviceLauncher(device.id);
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busyId.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <PageHeader :title="i18n.t('devices.title')" />

    <p class="text-sm text-muted">{{ i18n.t('devices.intro') }}</p>
    <p v-if="error" class="text-sm text-red-600" role="alert">{{ error }}</p>

    <AppSkeleton v-if="loading" :count="3" />

    <template v-else>
      <!-- 浏览器会话 -->
      <section class="space-y-2">
        <h2 class="text-sm font-semibold text-muted">{{ i18n.t('devices.browser_section') }}</h2>
        <AppCard v-for="device in browserDevices" :key="device.id" class="flex flex-wrap items-center gap-3 p-4">
          <AppIcon name="devices" class="text-brand-600 !text-2xl" />
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 font-medium">
              {{ describeBrowser(device.userAgent) }}
              <span v-if="device.current" class="badge !bg-brand-500/15 !text-brand-600">{{ i18n.t('devices.current') }}</span>
            </p>
            <p class="mt-0.5 text-xs text-muted">
              IP {{ device.ip || i18n.t('devices.unknown_ip') }}
              · {{ i18n.t('devices.last_active') }} {{ i18n.d(device.lastSeenAt) }}
            </p>
          </div>
          <AppButton
            class="btn-sm"
            :class="device.current ? '' : '!text-red-600'"
            :loading="busyId === device.id"
            @click="revokeSession(device)"
          >
            {{ i18n.t(device.current ? 'devices.sign_out' : 'devices.kick') }}
          </AppButton>
        </AppCard>
        <p v-if="browserDevices.length === 0" class="text-sm text-muted">{{ i18n.t('devices.empty_browser') }}</p>
      </section>

      <!-- 游戏启动器 -->
      <section class="space-y-2">
        <h2 class="text-sm font-semibold text-muted">{{ i18n.t('devices.launcher_section') }}</h2>
        <AppCard v-for="device in launcherDevices" :key="device.id" class="flex flex-wrap items-center gap-3 p-4">
          <AppIcon name="sports_esports" class="text-brand-600 !text-2xl" />
          <div class="min-w-0 flex-1">
            <p class="font-medium">{{ i18n.t('devices.launcher_of', { player: device.playerName }) }}</p>
            <p class="mt-0.5 text-xs text-muted">
              {{ i18n.t('devices.logged_in_at') }} {{ i18n.d(device.createdAt) }}
              · {{ i18n.t('devices.expires') }} {{ i18n.d(device.expiresAt) }}
            </p>
          </div>
          <AppButton class="btn-sm !text-red-600" :loading="busyId === device.id" @click="revokeLauncher(device)">
            {{ i18n.t('devices.kick') }}
          </AppButton>
        </AppCard>
        <p v-if="launcherDevices.length === 0" class="text-sm text-muted">{{ i18n.t('devices.empty_launcher') }}</p>
      </section>
    </template>
  </div>
</template>
