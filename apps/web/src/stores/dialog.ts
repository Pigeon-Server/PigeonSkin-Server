import { ref } from 'vue';
export const dialogState = ref<{ title: string; initial?: string; input?: boolean; type?: string; resolve: (value: string | boolean | null) => void } | null>(null);
function ask(title: string, initial?: string, type?: string) {
  if (dialogState.value) dialogState.value.resolve(null);
  return new Promise<string | boolean | null>((resolve) => {
    dialogState.value = { title, resolve, ...(initial !== undefined ? { initial, input: true } : {}), ...(type ? { type } : {}) };
  });
}
export async function confirmAction(title: string) { return (await ask(title)) === true; }
export async function promptValue(title: string, initial = '', type = 'text') { const v = await ask(title, initial, type); return typeof v === 'string' ? v : null; }
