/**
 * Per-step console/network capture + in-flight request tracking
 * (auto-test-mode-spec §6.5). REUSES the existing main-world capture
 * (public/injected.js) rather than re-patching: an isolated-world
 * fetch/XHR patch cannot see the page's own requests (see AGENTS.md,
 * "Capturing page-context signals" — deviation from the spec's
 * "patch in the content script world", which MV3 isolated worlds preclude).
 * injected.js additionally posts request-start/request-end for the counter.
 */
import { redactText, redactUrlToPath } from '@qa-copilot/shared';

const MAX_CONSOLE = 10;
const MAX_CONSOLE_CHARS = 300;
const MAX_REQUESTS = 10;

export interface StepCapture {
  start(): void;
  stop(): void;
  /** In-flight tracked page requests, for settle's network-idle condition. */
  inFlight(): number;
  /** Return and clear the per-step buffers (§6.2.6). */
  drain(): {
    consoleErrors: string[];
    failedRequests: Array<{ method: string; url: string; status: number }>;
  };
}

export function createStepCapture(win: Window = window): StepCapture {
  let running = false;
  let inFlight = 0;
  let consoleErrors: string[] = [];
  let failedRequests: Array<{ method: string; url: string; status: number }> = [];

  const onMessage = (e: MessageEvent) => {
    if (e.source !== win) return;
    const data = e.data;
    if (!data || data.__qaCopilot !== 'qa-copilot-page') return;
    switch (data.kind) {
      case 'request-start':
        inFlight += 1;
        break;
      case 'request-end':
        inFlight = Math.max(0, inFlight - 1);
        break;
      case 'console':
        if (data.level !== 'warning' && consoleErrors.length < MAX_CONSOLE) {
          consoleErrors.push(redactText(String(data.message ?? '')).slice(0, MAX_CONSOLE_CHARS));
        }
        break;
      case 'network':
        if (failedRequests.length < MAX_REQUESTS) {
          failedRequests.push({
            method: String(data.method ?? 'GET'),
            url: redactUrlToPath(String(data.urlPath ?? '')),
            status: Number(data.status ?? 0),
          });
        }
        break;
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      win.addEventListener('message', onMessage);
    },
    stop() {
      if (!running) return;
      running = false;
      win.removeEventListener('message', onMessage);
    },
    inFlight: () => inFlight,
    drain() {
      const drained = { consoleErrors, failedRequests };
      consoleErrors = [];
      failedRequests = [];
      return drained;
    },
  };
}
