<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { adminApi, type TicketCategory, type TicketSummary } from '@/api';
import { useI18n } from '@/stores/i18n';
import { useRouter } from 'vue-router';
import { apiErrorMessage } from '@/lib/api-error';
const i18n = useI18n(); const router = useRouter(); const items = ref<TicketSummary[]>([]); const categories = ref<TicketCategory[]>([]); const status = ref(''); const categoryId = ref(''); const user = ref(''); const loading = ref(true); const error = ref('');
async function load() { loading.value = true; try { const [categoryData, data] = await Promise.all([adminApi.ticketCategories(), adminApi.tickets({ status: status.value, categoryId: categoryId.value ? Number(categoryId.value) : undefined, user: user.value })]); categories.value = categoryData.items; items.value = data.items; } catch (e) { error.value = apiErrorMessage(e); } finally { loading.value = false; } }
function label(value: string) { return i18n.t(`ticket.status.${value}`); } onMounted(load);
</script>
<template>
  <PageHeader :title="i18n.t('ticket.manage')"><router-link to="/admin/ticket-categories" class="btn">{{ i18n.t('ticket.category_manage') }}</router-link></PageHeader>
  <p v-if="error" class="alert alert-danger">{{ error }}</p>
  <div class="mb-4 flex flex-wrap gap-2"><AppSelect v-model="status" :options="[{ value: '', label: i18n.t('ticket.all_statuses') }, ...['pending', 'in_progress', 'waiting_user', 'resolved', 'closed'].map(value => ({ value, label: label(value) }))]" @change="load" /><AppSelect v-model="categoryId" :options="[{ value: '', label: i18n.t('ticket.all_categories') }, ...categories.map(category => ({ value: String(category.id), label: category.name + (category.hidden ? ` (${i18n.t('ticket.category_hidden')})` : '') }))]" @change="load" /><AppInput v-model="user" :placeholder="i18n.t('ticket.user_filter')" @keyup.enter="load" /><AppButton @click="load">{{ i18n.t('common.search') }}</AppButton></div>
  <div class="panel !p-0 overflow-x-auto"><table class="table"><thead><tr><th>{{ i18n.t('ticket.number') }}</th><th>{{ i18n.t('ticket.subject') }}</th><th>{{ i18n.t('ticket.category_label') }}</th><th>{{ i18n.t('ticket.user') }}</th><th>{{ i18n.t('ticket.status_label') }}</th><th>{{ i18n.t('ticket.updated') }}</th></tr></thead><tbody><tr v-for="item in items" :key="item.id" class="cursor-pointer" @click="router.push(`/admin/tickets/${item.id}`)"><td class="font-mono">{{ item.ticketNumber }} <span v-if="item.adminUnread" class="badge badge-warning">{{ i18n.t('ticket.unread') }}</span></td><td>{{ item.title }}</td><td>{{ item.categoryName }}</td><td>{{ item.userNickname || item.userEmail }}</td><td><span class="badge">{{ label(item.status) }}</span></td><td class="text-muted">{{ i18n.d(item.updatedAt, 'short') }}</td></tr><tr v-if="!loading && !items.length"><td colspan="6" class="py-10 text-center text-muted">{{ i18n.t('ticket.empty') }}</td></tr></tbody></table><AppSkeleton v-if="loading" class="p-4" :count="4" /></div>
</template>
