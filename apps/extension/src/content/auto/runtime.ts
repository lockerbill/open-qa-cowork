/**
 * Content-script side of the AUTO_* protocol (auto-test-mode-spec §7.3): owns
 * one PageDriver per run — created lazily on the first AUTO_OBSERVE for a
 * runId, disposed when the overlay is hidden (finalize/pause) or a different
 * runId arrives — and routes the stop-overlay's callbacks to the service
 * worker (§6.6). Executed actions mirror into the session recorder through
 * the normal ACTION_EVENT pipeline.
 */
import type { ActionEvent } from '@qa-copilot/shared';
import type {
  AutoExecuteResponse,
  AutoObserveResponse,
  AutoToContent,
} from '../../background/auto/messages.js';
import { createPageDriver } from './page-driver.js';
import { showStopOverlay, type StopOverlayHandle } from './stop-overlay.js';
import type { PageDriver } from './types.js';

interface ActiveRun {
  runId: string;
  sessionId: string | null;
  driver: PageDriver | null;
  overlay: StopOverlayHandle | null;
}

let active: ActiveRun | null = null;

function send(message: { type: string; [key: string]: unknown }): void {
  chrome.runtime.sendMessage(message).catch(() => {
    /* SW may be restarting */
  });
}

function cleanup(): void {
  active?.overlay?.hide();
  active?.driver?.dispose();
  active = null;
}

function ensureRun(runId: string): ActiveRun {
  if (active && active.runId !== runId) cleanup();
  active ??= { runId, sessionId: null, driver: null, overlay: null };
  return active;
}

function ensureDriver(run: ActiveRun, sessionId: string): PageDriver {
  run.sessionId = sessionId;
  run.driver ??= createPageDriver({
    sessionId,
    emitRecorderEvent: (event: ActionEvent) => send({ type: 'ACTION_EVENT', event }),
  });
  return run.driver;
}

export async function handleAutoMessage(
  msg: AutoToContent,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  try {
    switch (msg.type) {
      case 'AUTO_OBSERVE': {
        const run = ensureRun(msg.runId);
        const driver = ensureDriver(run, msg.sessionId);
        const bundle = await driver.observe();
        sendResponse({
          ok: true,
          observation: bundle.observation,
          elements: bundle.elements,
        } satisfies AutoObserveResponse);
        return;
      }
      case 'AUTO_EXECUTE': {
        const driver = active?.runId === msg.runId ? active.driver : null;
        if (!driver) {
          sendResponse({
            ok: false,
            reason: 'error',
            detail: 'no active driver for run (observe first)',
            settled: true,
            navigated: false,
          } satisfies AutoExecuteResponse);
          return;
        }
        sendResponse(await driver.execute(msg.action, msg.epoch));
        return;
      }
      case 'AUTO_SHOW_OVERLAY': {
        const run = ensureRun(msg.runId);
        run.overlay?.hide();
        run.overlay = showStopOverlay(
          () => send({ type: 'AUTO_USER_STOP', runId: msg.runId }),
          () => send({ type: 'AUTO_USER_INTERVENED', runId: msg.runId }),
        );
        sendResponse({ ok: true });
        return;
      }
      case 'AUTO_HIDE_OVERLAY': {
        if (active?.runId === msg.runId) cleanup();
        sendResponse({ ok: true });
        return;
      }
    }
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
