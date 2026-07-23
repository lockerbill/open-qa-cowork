/**
 * Chrome-backed glue for the run controller: implements RunControllerDeps
 * against real extension APIs, routes AUTO_* messages (§7.3), watches
 * webNavigation for origin containment (§7.4), and runs the SW-wake check
 * that turns a persisted `running` run into `paused` (§7.1).
 *
 * Everything decision-shaped lives in run-controller.ts (unit-tested); this
 * file is deliberately thin plumbing exercised by the E2E suite.
 */
import type { RunConfig, RunResult, StepRequest, StepResponse } from '@qa-copilot/shared/auto';
import { STATE_CHANGED } from '../../shared/messages.js';
import { getAuth, getSession, getSettings, newSession, saveSession } from '../../shared/storage.js';
import { runExclusive } from '../mutex.js';
import {
  isAutoMessage,
  type AutoExecuteResponse,
  type AutoMessage,
  type AutoObserveResponse,
  type AutoStateMsg,
  type PersistedAutoRun,
} from './messages.js';
import { DeciderValidationError, isFinalStatus, RunController } from './run-controller.js';

const PERSIST_KEY = 'autoRun';
/**
 * Credential vault (§9.4): name → value in chrome.storage.session (trusted
 * contexts only; cleared on browser close). Written directly by the side
 * panel's credentials editor — values never travel through runtime messages.
 */
const VAULT_KEY = 'autoVault';

async function persistRun(state: PersistedAutoRun): Promise<void> {
  await chrome.storage.session.set({ [PERSIST_KEY]: state });
}

async function readVault(): Promise<Record<string, string>> {
  const stored = await chrome.storage.session.get(VAULT_KEY);
  const vault = stored[VAULT_KEY];
  return vault && typeof vault === 'object' ? (vault as Record<string, string>) : {};
}

/** Attach the finalized RunResult to its recorder session (§5.4, §10). */
async function saveRunResult(result: RunResult): Promise<void> {
  await runExclusive(async () => {
    const session = await getSession();
    if (session.id !== result.sessionId) return;
    session.autoRunResult = result;
    await saveSession(session);
  });
}

async function readPersistedRun(): Promise<PersistedAutoRun | null> {
  const stored = await chrome.storage.session.get(PERSIST_KEY);
  return (stored[PERSIST_KEY] as PersistedAutoRun | undefined) ?? null;
}

/** Shared /auto/step response handling: 422 → correction turn (§8.5). */
async function readStepResponse(res: Response): Promise<StepResponse> {
  if (res.status === 422) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new DeciderValidationError(payload.detail ?? 'invalid action');
  }
  if (!res.ok) throw new Error(`decider HTTP ${res.status}`);
  return (await res.json()) as StepResponse;
}

/**
 * Decide the next action (§8 contract). With a `deciderBaseUrl` override the
 * SW POSTs {base}/auto/step unauthenticated — E2E points this at the stub
 * decider (§13.2). Otherwise it targets the real workspace-scoped endpoint the
 * same way the extension calls the ai-tasks gateway: bearer token + workspace
 * path + project/environment context for layered provider resolution.
 */
async function decide(baseUrl: string, request: StepRequest): Promise<StepResponse> {
  if (baseUrl) {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/auto/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    return readStepResponse(res);
  }

  const [settings, auth] = await Promise.all([getSettings(), getAuth()]);
  if (!auth.token || !auth.currentWorkspaceId) {
    throw new Error('auto mode requires a signed-in workspace (or a deciderBaseUrl override)');
  }
  const base = settings.backendUrl.replace(/\/+$/, '');
  const body = {
    ...request,
    ...(auth.currentProjectId ? { projectId: auth.currentProjectId } : {}),
    ...(auth.currentEnvironmentId ? { environmentId: auth.currentEnvironmentId } : {}),
  };
  const res = await fetch(`${base}/api/workspaces/${auth.currentWorkspaceId}/auto/step`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    body: JSON.stringify(body),
  });
  return readStepResponse(res);
}

async function injectContentScript(tabId: number): Promise<boolean> {
  const declared = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: declared });
    return true;
  } catch {
    return false;
  }
}

async function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.status === 'complete') return;
  await new Promise<void>((resolve) => {
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(() => done(), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Auto runs write into a fresh recorder session (design: auto runs persist as
 * normal recorder sessions), and the manual recorder runs alongside so human
 * interventions are captured too — the dispatch bracket dedupes synthetics.
 */
async function startRecordingSession(tabId: number): Promise<string> {
  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const session = newSession();
  session.status = 'recording';
  session.environment = settings.environment;
  session.browser = 'Chrome';
  if (tab?.url) {
    session.baseUrl = tab.url;
    session.currentUrl = tab.url;
  }
  // Same mutex as index.ts's updateSession: an in-flight PAGE_MODEL
  // read-modify-write would otherwise clobber this write with a stale session.
  await runExclusive(() => saveSession(session));
  chrome.tabs.sendMessage(tabId, { type: 'START_RECORDING' }).catch(() => {});
  chrome.runtime.sendMessage({ type: STATE_CHANGED }).catch(() => {});
  return session.id;
}

async function stopRecordingSession(tabId: number): Promise<void> {
  await runExclusive(async () => {
    const session = await getSession();
    if (session.status === 'recording') {
      session.status = 'stopped';
      session.endedAt = new Date().toISOString();
      await saveSession(session);
    }
  });
  chrome.tabs.sendMessage(tabId, { type: 'STOP_RECORDING' }).catch(() => {});
  chrome.runtime.sendMessage({ type: STATE_CHANGED }).catch(() => {});
}

function createController(): RunController {
  return new RunController({
    observe: async (tabId, runId, sessionId) =>
      (await chrome.tabs.sendMessage(tabId, {
        type: 'AUTO_OBSERVE',
        runId,
        sessionId,
      })) as AutoObserveResponse,
    execute: async (tabId, runId, epoch, action) =>
      (await chrome.tabs.sendMessage(tabId, {
        type: 'AUTO_EXECUTE',
        runId,
        epoch,
        action,
      })) as AutoExecuteResponse,
    showOverlay: async (tabId, runId) => {
      await chrome.tabs.sendMessage(tabId, { type: 'AUTO_SHOW_OVERLAY', runId });
    },
    hideOverlay: async (tabId, runId) => {
      await chrome.tabs.sendMessage(tabId, { type: 'AUTO_HIDE_OVERLAY', runId });
    },
    injectContentScript,
    decide,
    getTabUrl: async (tabId) => (await chrome.tabs.get(tabId).catch(() => null))?.url ?? null,
    waitForTabLoad,
    startRecordingSession,
    stopRecordingSession,
    readVault,
    saveRunResult,
    persist: persistRun,
    pushState: (state: AutoStateMsg) => {
      chrome.runtime.sendMessage(state).catch(() => {});
    },
    log: (message) => console.debug('[QA Copilot]', message),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

let controller = createController();

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

async function startRun(config: RunConfig, explicitTabId?: number): Promise<string> {
  const tabId = explicitTabId ?? (await activeTabId());
  if (tabId == null) throw new Error('no target tab for the auto run');
  if (!controller.isActive()) controller = createController();
  return controller.start(config, tabId);
}

/** Route one AUTO_* message; always responds (possibly with {ok:false}). */
export async function handleAutoMessage(
  msg: AutoMessage,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  try {
    switch (msg.type) {
      case 'AUTO_START': {
        const runId = await startRun(msg.config, msg.tabId);
        sendResponse({ ok: true, runId });
        return;
      }
      case 'AUTO_PAUSE':
        if (controller.acceptsRunId(msg.runId)) controller.pause('paused_by_user');
        sendResponse({ ok: true });
        return;
      case 'AUTO_RESUME':
        if (controller.acceptsRunId(msg.runId)) controller.resume();
        sendResponse({ ok: true });
        return;
      case 'AUTO_STOP':
        if (controller.acceptsRunId(msg.runId)) controller.stop();
        sendResponse({ ok: true });
        return;
      case 'AUTO_CONFIRMATION':
        if (controller.acceptsRunId(msg.runId)) controller.confirm(msg.approved, msg.note);
        sendResponse({ ok: true });
        return;
      case 'AUTO_USER_STOP':
        if (controller.acceptsRunId(msg.runId)) controller.stop();
        sendResponse({ ok: true });
        return;
      case 'AUTO_USER_INTERVENED':
        if (controller.acceptsRunId(msg.runId)) controller.userIntervened();
        sendResponse({ ok: true });
        return;
      case 'AUTO_GET_STATE': {
        const state = controller.getState() ?? (await readPersistedRun());
        sendResponse({ ok: true, state });
        return;
      }
      default:
        sendResponse({ ok: false, error: `unhandled auto message ${(msg as { type: string }).type}` });
    }
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export { isAutoMessage };

/**
 * SW-wake check (§7.1): a persisted, non-final run means the service worker
 * was killed mid-run — surface it as paused with its trace intact.
 */
export async function restorePersistedRunOnWake(): Promise<void> {
  const persisted = await readPersistedRun().catch(() => null);
  if (!persisted || isFinalStatus(persisted.status)) return;
  if (controller.isActive()) return; // same SW lifetime, run still live
  await controller.restore(persisted);
}

export function initAutoMode(): void {
  // Origin containment on every committed top-frame navigation (§7.4).
  chrome.webNavigation?.onCommitted.addListener((details) => {
    if (details.frameId === 0) controller.handleNavigationCommitted(details.tabId, details.url);
  });
  void restorePersistedRunOnWake();

  // E2E/dev surface: lets Playwright drive runs from the SW context without
  // the side panel (worker.evaluate). Not reachable from page content.
  (globalThis as Record<string, unknown>).__openqaAuto = {
    start: (config: RunConfig, tabId?: number) => startRun(config, tabId),
    pause: () => controller.pause('paused_by_user'),
    resume: () => controller.resume(),
    stop: () => controller.stop(),
    confirm: (approved: boolean, note?: string) => controller.confirm(approved, note),
    getState: () => controller.getState(),
  };
}
