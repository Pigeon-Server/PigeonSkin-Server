<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ticketApi, type TicketDetail } from '@/api';
import { useI18n } from '@/stores/i18n';
import { apiErrorMessage } from '@/lib/api-error';
const route = useRoute(); const i18n = useI18n(); const data = ref<TicketDetail | null>(null); const error = ref(''); const body = ref(''); const files = ref<File[]>([]); const busy = ref(false);
async function load() { try { data.value = await ticketApi.get(Number(route.params.id)); } catch (e) { error.value = apiErrorMessage(e); } }
async function reply() { if (!body.value.trim() || busy.value) return; busy.value = true; try { await ticketApi.reply(Number(route.params.id), body.value, files.value); body.value = ''; files.value = []; await load(); } catch (e) { error.value = apiErrorMessage(e); } finally { busy.value = false; } }
function status(value: string) { return i18n.t(`ticket.status.${value}`); } onMounted(load);
</script>
<template>
  <PageHeader :title="data?.ticket.ticketNumber || i18n.t('ticket.title')" /><p v-if="error" class="alert alert-danger">{{ error }}</p><AppSkeleton v-if="!data && !error" :count="4" />
  <div v-if="data" class="space-y-4"><section class="panel"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="text-lg font-semibold">{{ data.ticket.title }}</h2><span class="badge">{{ status(data.ticket.status) }}</span></div><p class="mt-2 text-sm text-muted">{{ data.ticket.categoryName }} · {{ i18n.d(data.ticket.createdAt) }}</p></section>
    <section class="space-y-3"><article v-for="message in data.messages" :key="message.id" class="rounded-xl border border-line p-4" :class="message.authorType === 'user' ? 'bg-brand-50 ml-8' : 'bg-surface mr-8'"><div class="flex justify-between text-xs text-muted"><span>{{ message.authorType === 'user' ? i18n.t('ticket.you') : i18n.t('ticket.support') }}</span><span>{{ i18n.d(message.createdAt) }}</span></div><p class="mt-2 whitespace-pre-wrap break-words">{{ message.body }}</p><div v-for="file in data.attachments.filter(a => a.messageId === message.id)" :key="file.id" class="mt-2 text-sm"><a class="text-brand-600 hover:underline" :href="ticketApi.attachmentUrl(data.ticket.id, file.id)">{{ file.fileName }}</a></div></article></section>
    <section class="panel space-y-3"><AppInput v-model="body" multiline class="w-full min-h-28" :placeholder="i18n.t('ticket.reply_placeholder')" maxlength="20000" /><input type="file" multiple accept="image/*,.pdf,.txt,.csv,.zip" @change="files = Array.from(($event.target as HTMLInputElement).files || [])"><AppButton class="btn-primary" :loading="busy" @click="reply">{{ i18n.t('ticket.reply') }}</AppButton></section>
  </div>
</template>
