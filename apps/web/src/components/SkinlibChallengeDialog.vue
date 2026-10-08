<script setup lang="ts">
// 皮肤库反爬挑战弹窗：超频触发时展示人机验证，通过后由 store 唤醒等待中的请求。
// 关闭弹窗等于取消，等待方拿回 null 并展示原始错误。
import { computed, ref } from 'vue';
import { useI18n } from '@/stores/i18n';
import { settleSkinlibChallenge, skinlibChallengeOpen } from '@/stores/skinlib-challenge';
import VerificationChallenge from '@/components/VerificationChallenge.vue';

const i18n = useI18n();
const token = ref('');
const randstr = ref('');

const open = computed({
  get: () => skinlibChallengeOpen.value,
  set: (value) => {
    if (!value) settleSkinlibChallenge(null);
  },
});

function submit() {
  if (!token.value) return;
  settleSkinlibChallenge({ token: token.value, randstr: randstr.value });
}
</script>
<template>
  <AppDialog v-model="open" :title="i18n.t('skinlib.challenge_title')">
    <!-- v-if 让每次打开都重新挂载验证码组件：image 驱动换新题，第三方 widget 重建 -->
    <div v-if="skinlibChallengeOpen" class="flex flex-col gap-4">
      <p class="text-sm text-muted">{{ i18n.t('skinlib.challenge_description') }}</p>
      <VerificationChallenge v-model="token" v-model:randstr="randstr" />
      <div class="flex justify-end gap-2">
        <AppButton @click="settleSkinlibChallenge(null)">{{ i18n.t('common.cancel') }}</AppButton>
        <AppButton class="btn-primary" :disabled="!token" @click="submit">
          {{ i18n.t('skinlib.challenge_continue') }}
        </AppButton>
      </div>
    </div>
  </AppDialog>
</template>
