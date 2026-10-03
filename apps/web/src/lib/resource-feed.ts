import { ref, shallowRef } from 'vue';

export interface FeedPage<T> { items: T[]; page: number; totalPages: number; total: number }
export type PageLoader<T> = (page: number) => Promise<FeedPage<T>>;
export interface FeedSnapshot<T> extends FeedPage<T> { savedAt: number }

export function createResourceFeed<T extends { id: number }>() {
  const items = shallowRef<T[]>([]);
  const page = ref(0), totalPages = ref(1), total = ref(0);
  const loading = ref(true), loadingMore = ref(false), error = shallowRef<unknown>(null);
  let generation = 0;
  let loader: PageLoader<T> | null = null;
  function accept(data: FeedPage<T>) {
    const merged = new Map(items.value.map(item => [item.id, item]));
    for (const item of data.items) merged.set(item.id, item);
    items.value = [...merged.values()];
    page.value = data.page; totalPages.value = Math.max(1, data.totalPages); total.value = data.total;
  }
  async function reset(fetchPage: PageLoader<T>, target = 1, preserveItems = false) {
    const current = ++generation;
    loader = fetchPage;
    const previousItems = items.value;
    if (!preserveItems) items.value = [];
    page.value = 0;
    totalPages.value = 1; total.value = 0; error.value = null;
    loading.value = true; loadingMore.value = false;
    try {
      for (let next = 1; next <= Math.max(1, target); next++) {
        const data = await fetchPage(next);
        if (current !== generation) return;
        if (next === 1 && preserveItems) items.value = [];
        accept(data);
        if (data.page >= data.totalPages) break;
      }
    } catch (failure) {
      if (current === generation) {
        error.value = failure;
        if (preserveItems && !items.value.length) items.value = previousItems;
      }
    }
    finally { if (current === generation) loading.value = false; }
  }
  async function more() {
    if (!loader || loading.value || loadingMore.value || page.value >= totalPages.value) return;
    const current = generation;
    const fetchPage = loader;
    loadingMore.value = true; error.value = null;
    try {
      const data = await fetchPage(page.value + 1);
      if (current === generation) accept(data);
    } catch (failure) { if (current === generation) error.value = failure; }
    finally { if (current === generation) loadingMore.value = false; }
  }
  function restore(snapshot: FeedSnapshot<T>, fetchPage: PageLoader<T>) {
    generation++; loader = fetchPage;
    items.value = snapshot.items; page.value = snapshot.page;
    totalPages.value = snapshot.totalPages; total.value = snapshot.total;
    loading.value = false; loadingMore.value = false; error.value = null;
  }
  function snapshot(): FeedSnapshot<T> { return { items: items.value, page: page.value, totalPages: totalPages.value, total: total.value, savedAt: Date.now() }; }
  function cancel() { generation++; loading.value = false; loadingMore.value = false; }
  return { items, page, totalPages, total, loading, loadingMore, error, reset, more, restore, snapshot, cancel };
}
