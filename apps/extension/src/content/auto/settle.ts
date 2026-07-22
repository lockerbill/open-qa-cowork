/**
 * Post-action settle detection (auto-test-mode-spec §6.5). Resolves when ALL
 * hold: no DOM mutations for `quietMs` (ignoring our own overlay), no
 * in-flight tracked requests, and document.readyState === 'complete'.
 * Hard timeout resolves `settled: false` — a reported outcome, not an error.
 */

export const SETTLE_QUIET_MS = 400;
export const SETTLE_MAX_MS = 5000;
const POLL_MS = 50;

export interface SettleOptions {
  /** In-flight tracked page requests (from step-capture). */
  inFlightRequests: () => number;
  quietMs?: number;
  maxMs?: number;
  doc?: Document;
}

export function settle(opts: SettleOptions): Promise<{ settled: boolean }> {
  const doc = opts.doc ?? document;
  const quietMs = opts.quietMs ?? SETTLE_QUIET_MS;
  const maxMs = opts.maxMs ?? SETTLE_MAX_MS;

  return new Promise((resolve) => {
    let lastMutation = Date.now();

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const el = m.target instanceof Element ? m.target : m.target.parentElement;
        if (el?.closest('[data-openqa-ignore]')) continue;
        lastMutation = Date.now();
        return;
      }
    });
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    const startedAt = Date.now();
    const finish = (settled: boolean) => {
      observer.disconnect();
      clearInterval(timer);
      resolve({ settled });
    };

    const timer = setInterval(() => {
      const now = Date.now();
      if (now - startedAt >= maxMs) {
        finish(false);
        return;
      }
      if (
        now - lastMutation >= quietMs &&
        opts.inFlightRequests() === 0 &&
        doc.readyState === 'complete'
      ) {
        finish(true);
      }
    }, POLL_MS);
  });
}
