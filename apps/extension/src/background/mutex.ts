/**
 * Storage-write mutex for the service worker. Every session read-modify-write
 * MUST go through this lock (index.ts message handlers AND auto/wiring.ts) or
 * concurrent content-script events clobber one another's writes — the exact
 * race that dropped auto events from the recorder session in M2.
 */
let lock: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}
