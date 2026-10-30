import { AsyncLocalStorage } from 'node:async_hooks';

type RequestMemoStore = Map<string, Promise<unknown>>;

const requestMemoStorage = new AsyncLocalStorage<RequestMemoStore>();

export function runWithRequestContext<T>(callback: () => T): T {
  return requestMemoStorage.run(new Map<string, Promise<unknown>>(), callback);
}

export function memoizeInRequest<T>(
  namespace: string,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const store = requestMemoStorage.getStore();
  if (!store) {
    return compute();
  }

  const compositeKey = `${namespace}\0${key}`;
  const existing = store.get(compositeKey) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }

  const promise = compute().catch((error: unknown) => {
    if (store.get(compositeKey) === promise) {
      store.delete(compositeKey);
    }
    throw error;
  });
  store.set(compositeKey, promise);
  return promise;
}

export function clearRequestMemo(namespacePrefix?: string): void {
  const store = requestMemoStorage.getStore();
  if (!store) return;

  if (!namespacePrefix) {
    store.clear();
    return;
  }

  const prefix = `${namespacePrefix}\0`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix) || key.startsWith(`${namespacePrefix}:`)) {
      store.delete(key);
    }
  }
}
