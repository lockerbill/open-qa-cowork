import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request context propagated across awaits so logs can be correlated. */
interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` (and everything it awaits) with the given request id in scope. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** The current request id, or undefined when called outside a request scope. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
