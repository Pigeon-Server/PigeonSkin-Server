<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { setupApi } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n(); const router = useRouter();
const status = ref<Awaited<ReturnType<typeof setupApi.status>> | null>(null); const loading = ref(true); const busy = ref(false); const error = ref('');
const form = reactive({ token: '', siteName: '', email: '', nickname: '', password: '' });
async function load() { loading.value = true; error.value = ''; try { status.value = await setupApi.status(); } catch(e) { error.value = apiErrorMessage(e); } finally { loading.value = false; } }
async function submit() { busy.value = true; error.value = ''; try { await setupApi.create(form); await router.push('/login'); } catch(e) { error.value = apiErrorMessage(e); } finally { busy.value = false; } }
onMounted(load);
</script>
<template>
  <h1 class="text-2xl font-semibold mb-6">{{ i18n.t('setup.title') }}</h1>
  <p v-if="error" class="alert alert-danger" role="alert">{{ error }}<AppButton class="btn-sm ml-2" @click="load">{{ i18n.t('common.retry') }}</AppButton></p>
  <p v-if="loading" role="status">{{ i18n.t('common.loading') }}</p>
  <EmptyState v-else-if="status?.locked" :title="i18n.t('setup.locked')" icon="lock"><router-link to="/login" class="btn">{{ i18n.t('general.login') }}</router-link></EmptyState>
  <AppForm v-else-if="status?.available" class="space-y-4" @submit.prevent="submit">
    <div v-for="field in ['siteName', 'email', 'nickname', 'password', 'token'] as const" :key="field"><label class="block mb-2" :for="`setup-${field}`">{{ i18n.t(`setup.${field === 'siteName' ? 'site_name' : field === 'email' ? 'admin_email' : field === 'nickname' ? 'admin_nickname' : field}`) }}</label><AppInput :id="`setup-${field}`" v-model="form[field]" :type="field === 'password' || field === 'token' ? 'password' : field === 'email' ? 'email' : 'text'" :minlength="field === 'password' ? 8 : 1" :maxlength="field === 'password' ? 32 : 200" required /></div>
    <p class="text-xs text-muted">{{ i18n.t('setup.token_hint') }}</p><AppButton class="btn-primary w-full" type="submit" :loading="busy">{{ i18n.t('setup.submit') }}</AppButton>
  </AppForm>
  <p v-else-if="status" class="alert alert-warning">{{ i18n.t('setup.unavailable') }}</p>
</template>
