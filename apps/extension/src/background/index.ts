/**
 * Background service worker (spec §12): session manager + message router +
 * screenshot capture + settings/allowlist. State lives in chrome.storage.local
 * (no backend persistence in MVP 1).
 *
 * All session mutations go through `runExclusive` so concurrent content-script
 * events (inputs, deferred clicks, route changes) cannot clobber one another's
 * read-modify-write on storage.
 */
import type { EvidenceItem, PageModel, TestSession } from '@qa-copilot/shared';
import {
  STATE_CHANGED,
  type ContentToBackground,
  type PanelState,
  type PanelToBackground,
} from '../shared/messages.js';
import {
  getPageModel,
  getSession,
  getSettings,
  newSession,
  savePageModel,
  saveSession,
  saveSettings,
} from '../shared/storage.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

function broadcast(): void {
  chrome.runtime.sendMessage({ type: STATE_CHANGED }).catch(() => {});
}

// --- serialized storage access -------------------------------------------

let lock: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

function updateSession(mutate: (session: TestSession) => void): Promise<TestSession> {
  return runExclusive(async () => {
    const session = await getSession();
    mutate(session);
    await saveSession(session);
    return session;
  });
}

// --- helpers --------------------------------------------------------------

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function isAllowed(origin: string | null): Promise<boolean> {
  if (!origin) return false;
  if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) return true;
  const settings = await getSettings();
  return settings.allowlist.includes(origin);
}

async function sendToActiveContent(message: unknown): Promise<void> {
  const tab = await activeTab();
  if (tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

async function buildState(): Promise<PanelState> {
  const [session, pageModel] = await Promise.all([getSession(), getPageModel()]);
  const tab = await activeTab();
  const origin = originOf(tab?.url);
  return {
    pageModel,
    session,
    recording: session.status === 'recording',
    activeOrigin: origin,
    allowed: await isAllowed(origin),
  };
}

// --- content -> background ------------------------------------------------

async function handleContentMessage(msg: ContentToBackground): Promise<void> {
  switch (msg.type) {
    case 'PAGE_MODEL': {
      const model: PageModel = msg.model;
      await savePageModel(model);
      await updateSession((s) => {
        s.currentUrl = model.summary.url;
        if (!s.baseUrl) s.baseUrl = model.summary.url;
      });
      break;
    }
    case 'ACTION_EVENT':
      await updateSession((s) => {
        if (s.status === 'recording') s.events.push(msg.event);
      });
      break;
    case 'ROUTE_CHANGE':
      await updateSession((s) => {
        s.currentUrl = msg.url;
        if (s.status === 'recording') {
          s.events.push({
            id: `event_nav_${Date.now().toString(36)}_${s.events.length}`,
            sessionId: s.id,
            type: 'navigation',
            value: msg.url,
            timestamp: new Date().toISOString(),
            resultSummary: `Navigated to ${msg.title || msg.url}`,
          });
        }
      });
      break;
    case 'CONSOLE_ERROR':
      await updateSession((s) => {
        s.consoleErrors.push(msg.entry);
        if (s.consoleErrors.length > 100) s.consoleErrors.shift();
      });
      break;
    case 'NETWORK_FAILURE':
      await updateSession((s) => {
        s.networkFailures.push(msg.failure);
        if (s.networkFailures.length > 100) s.networkFailures.shift();
      });
      break;
  }
  broadcast();
}

// --- panel -> background --------------------------------------------------

async function captureScreenshot(): Promise<void> {
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
  } catch (err) {
    console.debug('[QA Copilot] screenshot failed', err);
    return;
  }
  await updateSession((s) => {
    const evidence: EvidenceItem = {
      id: `evidence_${Date.now().toString(36)}`,
      sessionId: s.id,
      type: 'screenshot',
      dataUrl,
      capturedAt: new Date().toISOString(),
    };
    s.evidence.push(evidence);
  });
}

async function startRecording(): Promise<void> {
  const tab = await activeTab();
  const settings = await getSettings();
  await runExclusive(async () => {
    const fresh = newSession();
    fresh.status = 'recording';
    fresh.environment = settings.environment;
    fresh.browser = 'Chrome';
    if (tab?.url) {
      fresh.baseUrl = tab.url;
      fresh.currentUrl = tab.url;
    }
    await saveSession(fresh);
  });
  await sendToActiveContent({ type: 'START_RECORDING' });
}

async function handlePanelMessage(
  msg: PanelToBackground,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  switch (msg.type) {
    case 'GET_STATE':
      sendResponse(await buildState());
      return;
    case 'GET_SETTINGS':
      sendResponse(await getSettings());
      return;
    case 'SAVE_SETTINGS':
      await saveSettings(msg.settings);
      sendResponse({ ok: true });
      broadcast();
      return;
    case 'SCAN_ACTIVE_TAB':
      await sendToActiveContent({ type: 'SCAN_PAGE' });
      sendResponse({ ok: true });
      return;
    case 'START_RECORDING':
      await startRecording();
      sendResponse({ ok: true });
      broadcast();
      return;
    case 'STOP_RECORDING':
      await updateSession((s) => {
        s.status = 'stopped';
        s.endedAt = new Date().toISOString();
      });
      await sendToActiveContent({ type: 'STOP_RECORDING' });
      sendResponse({ ok: true });
      broadcast();
      return;
    case 'CLEAR_SESSION':
      await runExclusive(() => saveSession(newSession()));
      sendResponse({ ok: true });
      broadcast();
      return;
    case 'CAPTURE_SCREENSHOT':
      await captureScreenshot();
      sendResponse({ ok: true });
      broadcast();
      return;
    case 'ADD_ALLOWLIST_ORIGIN':
      sendResponse({ ok: await addAllowlistOrigin(msg.origin) });
      broadcast();
      return;
  }
}

/** Request the optional host permission + register the content script for an origin. */
async function addAllowlistOrigin(origin: string): Promise<boolean> {
  const pattern = `${origin}/*`;
  const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  if (!granted) return false;

  const settings = await getSettings();
  if (!settings.allowlist.includes(origin)) {
    settings.allowlist.push(origin);
    await saveSettings(settings);
  }

  const declared = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: `qa-${origin.replace(/[^a-z0-9]/gi, '_')}`,
        js: declared,
        matches: [pattern],
        runAt: 'document_idle',
      },
    ]);
  } catch (err) {
    console.debug('[QA Copilot] registerContentScripts failed (may already exist)', err);
  }

  // registerContentScripts only injects on future loads. Inject into any
  // already-open tab(s) on this origin so the current page is captured without
  // a manual reload. Query by URL pattern (not just the active tab) so the
  // options-page flow works too. The loader dynamic-imports its hashed chunk,
  // which is web-accessible on this origin thanks to the vite WAR transform.
  try {
    const tabs = await chrome.tabs.query({ url: pattern });
    await Promise.all(
      tabs
        .filter((t) => t.id != null)
        .map((t) =>
          chrome.scripting
            .executeScript({ target: { tabId: t.id! }, files: declared })
            .catch((err) => console.debug('[QA Copilot] inject failed', t.id, err)),
        ),
    );
  } catch (err) {
    console.debug('[QA Copilot] immediate inject failed', err);
  }
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as ContentToBackground | PanelToBackground;
  if (
    msg.type === 'PAGE_MODEL' ||
    msg.type === 'ACTION_EVENT' ||
    msg.type === 'ROUTE_CHANGE' ||
    msg.type === 'CONSOLE_ERROR' ||
    msg.type === 'NETWORK_FAILURE'
  ) {
    void handleContentMessage(msg as ContentToBackground);
    return false;
  }
  void handlePanelMessage(msg as PanelToBackground, sendResponse);
  return true; // async sendResponse
});
