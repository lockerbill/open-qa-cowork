/**
 * Content script entry. Bridges the page <-> background:
 *  - scans the DOM into a PageModel on demand and after SPA route changes
 *  - records manual actions while recording is active
 *  - relays page-context console/network capture (from injected.js)
 */
import type { ConsoleEntry, NetworkFailure } from '@qa-copilot/shared';
import { redactText, redactUrlToPath } from '@qa-copilot/shared';
import type { BackgroundToContent, ContentToBackground } from '../shared/messages.js';
import { scanPage } from './scanner.js';
import { createRecorder } from './recorder.js';

// Idempotency: the loader may be injected via executeScript (immediate capture
// on an already-open tab) and also registered for future loads. Initialize at
// most once per document so listeners aren't double-registered.
const w = window as unknown as { __qaCopilotContentLoaded?: boolean };
if (!w.__qaCopilotContentLoaded) {
  w.__qaCopilotContentLoaded = true;
  init();
}

function init(): void {
const SESSION_ID = `session_${Date.now().toString(36)}`;
let lastUrl = location.href;

function send(message: ContentToBackground): void {
  chrome.runtime.sendMessage(message).catch(() => {
    /* side panel/background may be closed */
  });
}

function scanAndSend(): void {
  try {
    const model = scanPage(document, location);
    send({ type: 'PAGE_MODEL', model });
  } catch (err) {
    console.debug('[QA Copilot] scan failed', err);
  }
}

const recorder = createRecorder(SESSION_ID, (event) => send({ type: 'ACTION_EVENT', event }));

// Inject the page-context capture script (console/network).
function injectPageScript(): void {
  try {
    const el = document.createElement('script');
    el.src = chrome.runtime.getURL('injected.js');
    el.onload = () => el.remove();
    (document.head || document.documentElement).appendChild(el);
  } catch {
    /* CSP may block; capture is best-effort */
  }
}

// Relay redacted console/network events from the page world.
window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data;
  if (!data || data.__qaCopilot !== 'qa-copilot-page') return;
  if (data.kind === 'route') {
    const url = String(data.url ?? location.href);
    if (url !== lastUrl) {
      lastUrl = url;
      send({ type: 'ROUTE_CHANGE', url, title: String(data.title ?? document.title) });
      scanAndSend();
    }
    return;
  }
  if (data.kind === 'console') {
    const entry: ConsoleEntry = {
      level: data.level === 'warning' ? 'warning' : 'error',
      message: redactText(String(data.message ?? '')).slice(0, 500),
      timestamp: new Date().toISOString(),
    };
    send({ type: 'CONSOLE_ERROR', entry });
  } else if (data.kind === 'network') {
    const failure: NetworkFailure = {
      method: String(data.method ?? 'GET'),
      urlPath: redactUrlToPath(String(data.urlPath ?? '')),
      status: Number(data.status ?? 0),
      reason: data.reason ? redactText(String(data.reason)) : undefined,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
      timestamp: new Date().toISOString(),
    };
    send({ type: 'NETWORK_FAILURE', failure });
  }
});

// Commands from the background.
chrome.runtime.onMessage.addListener((msg: BackgroundToContent) => {
  switch (msg.type) {
    case 'SCAN_PAGE':
      scanAndSend();
      break;
    case 'START_RECORDING':
      recorder.start();
      break;
    case 'STOP_RECORDING':
      recorder.stop();
      break;
  }
});

// SPA navigations are detected in the page world (injected.js) and relayed
// via the 'route' message above, then rescanned.
injectPageScript();
// Initial scan so the side panel has context as soon as it opens.
scanAndSend();
}
