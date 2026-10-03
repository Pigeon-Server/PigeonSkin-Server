import { ref } from 'vue';

const muted = ref(false);
try { muted.value = localStorage.getItem('live2d-muted') === 'true'; } catch { }

export function useLive2DVoice() {
  function toggle() {
    muted.value = !muted.value;
    try { localStorage.setItem('live2d-muted', String(muted.value)); } catch { }
  }
  return { muted, toggle };
}
