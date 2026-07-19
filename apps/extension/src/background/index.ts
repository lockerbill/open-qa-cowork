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
import { applyResolveMatch } from '../shared/context.js';
import {
  getAuth,
  getPageModel,
  getSession,
  getSettings,
  newSession,
  savePageModel,
  saveSession,
  saveSettings,
  updateAuth,
} from '../shared/storage.js';
import { resolveUrl } from '../sidepanel/backend.js';
import {
  JIRA_MESSAGE_TYPES,
  handleJiraMessage,
  type JiraMessage,
} from '../integrations/jira/messages.js';

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

/**
 * Inject the declared content-script bundle into a specific tab. Used both when
 * allowlisting an origin (immediate capture of already-open tabs) and when the
 * active tab changes to a tab that has no content script yet. The loader
 * dynamic-imports its hashed chunk, web-accessible on granted origins via the
 * vite WAR transform. Returns false (and swallows) if injection isn't possible.
 */
async function injectContentScript(tabId: number): Promise<boolean> {
  const declared = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: declared });
    return true;
  } catch (err) {
    console.debug('[QA Copilot] inject failed', tabId, err);
    return false;
  }
}

// Pages we can never scan; skip them rather than clearing/injecting.
const INTERNAL_URL = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;

// Dedupe key (`tabId|url`) so rapid/duplicate tab + load events don't re-scan
// the same page repeatedly. Reset to null to force the next refresh.
let lastRefreshKey: string | null = null;

/**
 * Match the active tab's URL to a configured project/environment via the
 * backend `resolve` endpoint and store the result on the auth context. Rides
 * the `refreshActiveTab` dedupe (one call per distinct tab+url), so it adds no
 * chatter on repeated focus events. No-ops when signed out or when the user has
 * a manual override; network/auth errors leave the existing context untouched.
 */
async function maybeResolveContext(tabUrl: string): Promise<void> {
  const auth = await getAuth();
  if (!auth.token || !auth.currentWorkspaceId || auth.contextSource === 'manual') return;

  const settings = await getSettings();
  let match;
  try {
    ({ match } = await resolveUrl(settings.backendUrl, auth.token, auth.currentWorkspaceId, tabUrl));
  } catch {
    return; // network / 401 — keep current context rather than clearing it
  }

  await runExclusive(() =>
    // Re-read inside the lock and re-apply the merge rules: a manual override
    // set between our read above and here must win (applyResolveMatch guards it).
    updateAuth((a) => Object.assign(a, applyResolveMatch(a, match ?? null))),
  );
  broadcast();
}

/**
 * React to the active tab changing (tab switch, window focus, or a load
 * completing in the active tab). Keeps the side panel showing the CURRENT tab
 * instead of a stale global page model: re-scans allowlisted tabs, and clears
 * the model for tabs we can't read so the panel falls back to the allowlist
 * banner rather than a wrong URL.
 */
async function refreshActiveTab(): Promise<void> {
  const tab = await activeTab();
  if (tab?.id == null || !tab.url || INTERNAL_URL.test(tab.url)) return;

  const key = `${tab.id}|${tab.url}`;
  if (key === lastRefreshKey) return;
  lastRefreshKey = key;

  // Project/environment auto-detection is independent of the local allowlist
  // (it matches the workspace's configured baseUrls), so run it for any
  // readable page before the allowlist branch.
  void maybeResolveContext(tab.url);

  const origin = originOf(tab.url);
  if (await isAllowed(origin)) {
    // Ask the content script to re-scan; if it isn't present yet, inject it —
    // content init() auto-scans on load. Either path emits PAGE_MODEL ->
    // savePageModel + broadcast, so no explicit broadcast is needed here.
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_PAGE' });
    } catch {
      await injectContentScript(tab.id);
    }
    return;
  }

  // Not allowed: drop the stale model so the panel shows "No page scanned" plus
  // this origin's allowlist banner instead of a previous tab's URL.
  await savePageModel(null);
  broadcast();
}

async function buildState(): Promise<PanelState> {
  const [session, pageModel, auth] = await Promise.all([getSession(), getPageModel(), getAuth()]);
  const tab = await activeTab();
  const origin = originOf(tab?.url);
  return {
    pageModel,
    session,
    recording: session.status === 'recording',
    activeOrigin: origin,
    allowed: await isAllowed(origin),
    auth: {
      signedIn: !!auth.token,
      role: auth.currentWorkspaceRole,
      workspaceId: auth.currentWorkspaceId,
      projectId: auth.currentProjectId,
      projectName: auth.currentProjectName,
      environmentId: auth.currentEnvironmentId,
      environmentName: auth.currentEnvironmentName,
      contextSource: auth.contextSource,
    },
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

async function captureScreenshot(): Promise<{ ok: boolean; error?: string }> {
  const tab = await activeTab();
  const origin = originOf(tab?.url);
  if (!(await isAllowed(origin))) {
    return { ok: false, error: 'Enable QA Copilot on this site first (use the banner), then retry.' };
  }

  let dataUrl: string;
  try {
    // Pass the tab's window explicitly — capturing from the side-panel /
    // service-worker context has no reliable "current window".
    dataUrl = await chrome.tabs.captureVisibleTab(tab!.windowId, { format: 'png' });
  } catch (err) {
    const raw = chrome.runtime.lastError?.message ?? (err as Error)?.message ?? 'Screenshot failed';
    // captureVisibleTab needs <all_urls> / activeTab; a per-origin grant isn't enough.
    const message = /all_urls|activeTab/i.test(raw)
      ? `${raw} — set Site access to "On all sites" in extension settings.`
      : raw;
    console.debug('[QA Copilot] screenshot failed', err);
    return { ok: false, error: message };
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
  return { ok: true };
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
  // Jira messages are handled by their own module, which owns the credentials
  // and returns a uniform { ok, ... } result rather than throwing at the router.
  if ((JIRA_MESSAGE_TYPES as readonly string[]).includes(msg.type)) {
    sendResponse(await handleJiraMessage(msg as JiraMessage));
    return;
  }

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
    case 'CAPTURE_SCREENSHOT': {
      const result = await captureScreenshot();
      sendResponse(result);
      if (result.ok) broadcast();
      return;
    }
    case 'OPEN_EXTENSION_SETTINGS':
      await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
      sendResponse({ ok: true });
      return;
    case 'ADD_ALLOWLIST_ORIGIN':
      sendResponse({ ok: await addAllowlistOrigin(msg.origin) });
      broadcast();
      return;
    case 'RESOLVE_ACTIVE_TAB': {
      const tab = await activeTab();
      if (tab?.url && !INTERNAL_URL.test(tab.url)) await maybeResolveContext(tab.url);
      sendResponse({ ok: true });
      return;
    }
    case 'SET_CONTEXT':
      await runExclusive(() =>
        updateAuth((a) => {
          a.currentProjectId = msg.projectId;
          a.currentProjectName = msg.projectName;
          a.currentEnvironmentId = msg.environmentId;
          a.currentEnvironmentName = msg.environmentName;
          a.contextSource = 'manual';
        }),
      );
      sendResponse({ ok: true });
      broadcast();
      return;
    case 'CLEAR_CONTEXT_OVERRIDE': {
      await runExclusive(() =>
        updateAuth((a) => {
          a.contextSource = null;
        }),
      );
      // Repopulate from auto-detection now that the override is gone.
      const tab = await activeTab();
      if (tab?.url && !INTERNAL_URL.test(tab.url)) await maybeResolveContext(tab.url);
      sendResponse({ ok: true });
      broadcast();
      return;
    }
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
  // options-page flow works too.
  try {
    const tabs = await chrome.tabs.query({ url: pattern });
    await Promise.all(
      tabs.filter((t) => t.id != null).map((t) => injectContentScript(t.id!)),
    );
  } catch (err) {
    console.debug('[QA Copilot] immediate inject failed', err);
  }
  // A freshly-allowlisted tab may be the active one; let the next active-tab
  // refresh re-evaluate it rather than being skipped by the dedupe guard.
  lastRefreshKey = null;
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

// --- active-tab tracking --------------------------------------------------
// The panel renders one global page model; without these listeners it would
// keep showing a previous tab's URL when the user switches tabs/windows.
chrome.tabs.onActivated.addListener(() => void refreshActiveTab());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void refreshActiveTab();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === 'complete') void refreshActiveTab();
});
