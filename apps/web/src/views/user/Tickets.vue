<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ticketApi, type TicketCategory, type TicketSummary } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useRouter } from 'vue-router';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n(); const router = useRouter();
const items = ref<TicketSummary[]>([]); const unread = ref(0); const loading = ref(true); const error = ref(''); const notice = ref(''); const busy = ref(false);
const categories = ref<TicketCategory[]>([]); const title = ref(''); const categoryId = ref(0); const description = ref(''); const files = ref<File[]>([]);
async function load() { loading.value = true; error.value = ''; try { const [categoryData, data] = await Promise.all([ticketApi.categories(), ticketApi.list()]); categories.value = categoryData.items; categoryId.value ||= categories.value[0]?.id || 0; items.value = data.items; unread.value = data.unread; } catch (e) { error.value = apiErrorMessage(e); } finally { loading.value = false; } }
async function create() { if (busy.value || !title.value.trim() || !description.value.trim() || !categoryId.value) return; busy.value = true; error.value = ''; try { const result = await ticketApi.create({ title: title.value, categoryId: categoryId.value, description: description.value, files: files.value }); title.value = ''; description.value = ''; files.value = []; notice.value = i18n.t('ticket.created'); await router.push(`/tickets/${result.id}`); } catch (e) { error.value = apiErrorMessage(e); } finally { busy.value = false; } }
function status(status: string) { return i18n.t(`ticket.status.${status}`); }
onMounted(load);
</script>
<template>
<PageHeader :title="i18n.t('ticket.title')"><span v-if="unread" class="badge badge-warning">{{ unread }} {{ i18n.t('ticket.unread') }}</span></PageHeader>
  <p v-if="notice" class="alert alert-success">{{ notice }}</p><p v-if="error" class="alert alert-danger">{{ error }}</p>
  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
    <section class="panel !p-0 overflow-x-auto"><table class="table"><thead><tr><th>{{ i18n.t('ticket.number') }}</th><th>{{ i18n.t('ticket.subject') }}</th><th>{{ i18n.t('ticket.category_label') }}</th><th>{{ i18n.t('ticket.status_label') }}</th><th>{{ i18n.t('ticket.updated') }}</th></tr></thead><tbody>
      <tr v-for="item in items" :key="item.id" class="cursor-pointer" @click="router.push(`/tickets/${item.id}`)"><td class="font-mono">{{ item.ticketNumber }} <span v-if="item.userUnread" class="badge badge-warning">{{ i18n.t('ticket.unread') }}</span></td><td class="font-medium">{{ item.title }}</td><td>{{ item.categoryName }}</td><td><span class="badge">{{ status(item.status) }}</span></td><td class="text-muted">{{ i18n.d(item.updatedAt, 'short') }}</td></tr>
      <tr v-if="!loading && !items.length"><td colspan="5" class="py-10 text-center text-muted">{{ i18n.t('ticket.empty') }}</td></tr>
    </tbody></table><AppSkeleton v-if="loading" class="p-4" :count="3" /></section>
    <section class="panel space-y-3"><h2 class="font-semibold">{{ i18n.t('ticket.create') }}</h2><AppInput v-model="title" class="w-full" :placeholder="i18n.t('ticket.subject')" maxlength="160" /><AppSelect v-model="categoryId" class="w-full" :options="categories.map(category => ({ value: category.id, label: category.name }))" /><AppInput v-model="description" multiline class="w-full min-h-32" :placeholder="i18n.t('ticket.description')" maxlength="20000" /><input type="file" multiple accept="image/*,.pdf,.txt,.csv,.zip" @change="files = Array.from(($event.target as HTMLInputElement).files || [])"><AppButton class="btn-primary w-full" :loading="busy" @click="create">{{ i18n.t('ticket.submit') }}</AppButton></section>
  </div>
</template>
