import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage<Map<string, WeakMap<object, Map<string, Promise<unknown>>>>>();

export function withRequestCache<T>(operation: () => T): T {
  return requests.run(new Map(), operation);
}

export function requestPending(namespace: string, database: object): Map<string, Promise<unknown>> {
  const store = requests.getStore();
  if (!store) return new Map();
  let databases = store.get(namespace);
  if (!databases) { databases = new WeakMap(); store.set(namespace, databases); }
  let pending = databases.get(database);
  if (!pending) { pending = new Map(); databases.set(database, pending); }
  return pending;
}
