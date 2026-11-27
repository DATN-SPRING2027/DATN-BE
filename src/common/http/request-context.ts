import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContextState {
  memo: Map<string, Promise<unknown>>;
  requestId?: string;
  traceparent?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContextState>();

export function runWithRequestContext<T>(
  callback: () => T,
  metadata?: { requestId?: string; traceparent?: string },
): T {
  return requestContextStorage.run(
    {
      memo: new Map<string, Promise<unknown>>(),
      requestId: metadata?.requestId,
      traceparent: metadata?.traceparent,
    },
    callback,
  );
}

export function getCurrentRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

export function getCurrentTraceparent(): string | undefined {
  return requestContextStorage.getStore()?.traceparent;
}

export function memoizeInRequest<T>(
  namespace: string,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const store = requestContextStorage.getStore()?.memo;
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
  const store = requestContextStorage.getStore()?.memo;
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
