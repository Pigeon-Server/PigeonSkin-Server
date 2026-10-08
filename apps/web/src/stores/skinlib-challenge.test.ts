// @vitest-environment jsdom
// 皮肤库反爬挑战的状态机单测：错误码识别、弹窗会话共享、取消与重试上限。
import { describe, expect, it, beforeEach } from 'vitest';
import { ApiError } from '@/api';
import {
  requestSkinlibChallenge,
  settleSkinlibChallenge,
  skinlibChallengeOpen,
  withSkinlibChallenge,
} from '@/stores/skinlib-challenge';

function challengeError(): ApiError {
  return new ApiError(429, { error: 'skinlib.challenge_required' });
}

/** 等一轮微任务，让 withSkinlibChallenge 走到弹出弹窗、注册等待者 */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

beforeEach(() => {
  // 清掉上一条用例可能遗留的等待者与打开状态
  settleSkinlibChallenge(null);
});

describe('withSkinlibChallenge', () => {
  it('passes through successful calls without opening a dialog', async () => {
    const result = await withSkinlibChallenge(async () => 'ok');
    expect(result).toBe('ok');
    expect(skinlibChallengeOpen.value).toBe(false);
  });

  it('rethrows unrelated errors untouched', async () => {
    const failure = new ApiError(500, { error: 'common.internal_error' });
    await expect(withSkinlibChallenge(async () => { throw failure; })).rejects.toBe(failure);
    expect(skinlibChallengeOpen.value).toBe(false);
  });

  it('opens the dialog on challenge_required and retries with the captcha headers', async () => {
    const calls: Array<Record<string, string>> = [];
    let attempts = 0;
    const task = withSkinlibChallenge(async (headers) => {
      calls.push(headers);
      attempts += 1;
      if (attempts === 1) throw challengeError();
      return 'browsed';
    });

    await settle();
    expect(skinlibChallengeOpen.value).toBe(true);
    settleSkinlibChallenge({ token: 'tk', randstr: 'rs' });

    await expect(task).resolves.toBe('browsed');
    expect(calls).toEqual([{}, { 'X-Captcha-Token': 'tk', 'X-Captcha-Randstr': 'rs' }]);
    expect(skinlibChallengeOpen.value).toBe(false);
  });

  it('omits randstr when a driver does not use it', async () => {
    const calls: Array<Record<string, string>> = [];
    let attempts = 0;
    const task = withSkinlibChallenge(async (headers) => {
      calls.push(headers);
      attempts += 1;
      if (attempts === 1) throw challengeError();
      return 'ok';
    });
    await settle();
    settleSkinlibChallenge({ token: 'tk', randstr: '' });
    await task;
    expect(calls[1]).toEqual({ 'X-Captcha-Token': 'tk' });
  });

  it('gives up after repeated wrong answers and rethrows the last error', async () => {
    let attempts = 0;
    const task = withSkinlibChallenge(async () => { attempts += 1; throw challengeError(); });
    // 每次弹窗都提交答案；答错服务端会再次返回同一错误码
    const autoAnswer = setInterval(() => settleSkinlibChallenge({ token: 'bad', randstr: '' }), 0);
    await expect(task).rejects.toMatchObject({ code: 'skinlib.challenge_required' });
    clearInterval(autoAnswer);
    expect(attempts).toBe(3);
    expect(skinlibChallengeOpen.value).toBe(false);
  });

  it('rethrows when the visitor cancels the dialog', async () => {
    const task = withSkinlibChallenge(async () => { throw challengeError(); });
    await settle();
    settleSkinlibChallenge(null);
    await expect(task).rejects.toMatchObject({ code: 'skinlib.challenge_required' });
    expect(skinlibChallengeOpen.value).toBe(false);
  });

  it('shares one dialog between concurrent waiters', async () => {
    const first = requestSkinlibChallenge();
    const second = requestSkinlibChallenge();
    expect(skinlibChallengeOpen.value).toBe(true);
    settleSkinlibChallenge({ token: 'tk', randstr: 'rs' });
    await expect(first).resolves.toEqual({ token: 'tk', randstr: 'rs' });
    await expect(second).resolves.toEqual({ token: 'tk', randstr: 'rs' });
  });
});
