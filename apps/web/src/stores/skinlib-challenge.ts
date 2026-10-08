// 皮肤库反爬挑战：429 skinlib.challenge_required 的弹窗与重试闭环。
//
// 皮肤库读取统一包在 withSkinlibChallenge 里：被反爬守卫要求人机验证时弹窗，
// 用户完成验证后带 token 自动重试；取消则把原始错误抛回页面照常展示。
import { ref } from 'vue';
import { ApiError } from '@/api';

export interface SkinlibChallengeAnswer {
  token: string;
  randstr: string;
}

/** 弹窗是否打开，由 App.vue 挂载的 SkinlibChallengeDialog 消费 */
export const skinlibChallengeOpen = ref(false);

const waiters: Array<(answer: SkinlibChallengeAnswer | null) => void> = [];

/** 请求一次人机验证；并发请求共享同一次弹窗与结果 */
export function requestSkinlibChallenge(): Promise<SkinlibChallengeAnswer | null> {
  return new Promise((resolve) => {
    waiters.push(resolve);
    skinlibChallengeOpen.value = true;
  });
}

/** 弹窗结束：提交答案或取消，唤醒所有等待者 */
export function settleSkinlibChallenge(answer: SkinlibChallengeAnswer | null): void {
  skinlibChallengeOpen.value = false;
  for (const resolve of waiters.splice(0, waiters.length)) resolve(answer);
}

/** 验证码答错会重新弹出；连错多次后放弃，把最后一次错误交给页面 */
const MAX_ATTEMPTS = 3;

export async function withSkinlibChallenge<T>(
  call: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  let headers: Record<string, string> = {};
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call(headers);
    } catch (error) {
      const needsChallenge = error instanceof ApiError && error.code === 'skinlib.challenge_required';
      if (!needsChallenge || attempt >= MAX_ATTEMPTS - 1) throw error;
      const answer = await requestSkinlibChallenge();
      if (!answer) throw error;
      headers = {
        'X-Captcha-Token': answer.token,
        ...(answer.randstr ? { 'X-Captcha-Randstr': answer.randstr } : {}),
      };
    }
  }
}
