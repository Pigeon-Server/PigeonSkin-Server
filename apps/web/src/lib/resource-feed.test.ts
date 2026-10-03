import { describe, expect, it } from 'vitest';
import { createResourceFeed, type FeedPage } from '@/lib/resource-feed';
type Item = { id: number; name: string };
function page(number: number, ids: number[], totalPages = 3): FeedPage<Item> { return { page: number, items: ids.map(id => ({ id, name: String(id) })), totalPages, total: 6 }; }

describe('resource feed', () => {
  it('retains existing cards while loading the next page and removes repeated IDs', async () => {
    const feed = createResourceFeed<Item>();
    let resolve!: (value: FeedPage<Item>) => void;
    await feed.reset(async number => number === 1 ? page(1, [1, 2]) : new Promise(done => { resolve = done; }));
    const pending = feed.more();
    expect(feed.items.value.map(item => item.id)).toEqual([1, 2]);
    expect(feed.loadingMore.value).toBe(true);
    resolve(page(2, [2, 3])); await pending;
    expect(feed.items.value.map(item => item.id)).toEqual([1, 2, 3]);
  });
  it('ignores a previous filter response after a new filter is selected', async () => {
    const feed = createResourceFeed<Item>();
    let resolve!: (value: FeedPage<Item>) => void;
    const stale = feed.reset(() => new Promise(done => { resolve = done; }));
    await feed.reset(async () => page(1, [5]));
    resolve(page(1, [1, 2])); await stale;
    expect(feed.items.value.map(item => item.id)).toEqual([5]);
  });
  it('keeps loaded pages after an error and retries the same page', async () => {
    const feed = createResourceFeed<Item>(); let fail = true;
    await feed.reset(async number => {
      if (number === 1) return page(1, [1]);
      if (fail) throw new Error('Offline');
      return page(number, [2]);
    });
    await feed.more(); expect(feed.page.value).toBe(1); expect(feed.items.value).toHaveLength(1);
    expect(feed.error.value).toBeInstanceOf(Error);
    fail = false; await feed.more(); expect(feed.page.value).toBe(2); expect(feed.items.value).toHaveLength(2);
  });
  it('restores a browsing snapshot and continues from its final loaded page', async () => {
    const feed = createResourceFeed<Item>();
    await feed.reset(async number => page(number, [number]), 2);
    const restored = createResourceFeed<Item>();
    restored.restore(feed.snapshot(), async number => page(number, [number]));
    await restored.more(); expect(restored.items.value.map(item => item.id)).toEqual([1, 2, 3]);
  });
});
