/**
 * Typed AUTO_* message protocol (auto-test-mode-spec §7.3). Every run-scoped
 * message carries `runId`; the run controller drops and logs messages whose
 * runId is not the active run. AUTO_START necessarily has no runId (it mints
 * one) and AUTO_GET_STATE is a query about whatever run exists.
 */
import type {
  Action,
  Observation,
  ObservedElement,
  RunConfig,
  RunStatus,
  TraceStep,
} from '@qa-copilot/shared/auto';
import type { ActionResult } from '../../content/auto/types.js';

/** Internal state-machine phases (§7.1); the panel-facing RunStatus is derived. */
export type RunPhase =
  | 'idle'
  | 'starting'
  | 'observing'
  | 'deciding'
  | 'guarding'
  | 'awaiting_confirmation'
  | 'executing'
  | 'post_step'
  | 'paused'
  | 'finalizing'
  | 'done';

/** Budget usage pushed with every AUTO_STATE (§9.6). */
export interface BudgetSnapshot {
  stepsUsed: number;
  maxSteps: number;
  llmCalls: number;
  maxLlmCalls: number;
  elapsedMs: number;
  maxWallClockMs: number;
  /** Stale-epoch re-observe/re-decide retries (§7.2) — observable for tests. */
  staleEpochRetries: number;
}

// --- SW -> content script ---------------------------------------------------

export interface AutoObserveMsg {
  type: 'AUTO_OBSERVE';
  runId: string;
  /** Recorder session the run's auto events are written into. */
  sessionId: string;
}

export interface AutoExecuteMsg {
  type: 'AUTO_EXECUTE';
  runId: string;
  /** Epoch of the observation this action targets (§6.4.1). */
  epoch: number;
  action: Action;
}

export interface AutoShowOverlayMsg {
  type: 'AUTO_SHOW_OVERLAY';
  runId: string;
}

export interface AutoHideOverlayMsg {
  type: 'AUTO_HIDE_OVERLAY';
  runId: string;
}

export type AutoToContent =
  | AutoObserveMsg
  | AutoExecuteMsg
  | AutoShowOverlayMsg
  | AutoHideOverlayMsg;

export type AutoObserveResponse =
  | { ok: true; observation: Observation; elements: ObservedElement[] }
  | { ok: false; error: string };

export type AutoExecuteResponse = ActionResult;

// --- content script -> SW ---------------------------------------------------

export interface AutoUserStopMsg {
  type: 'AUTO_USER_STOP';
  runId: string;
}

export interface AutoUserIntervenedMsg {
  type: 'AUTO_USER_INTERVENED';
  runId: string;
}

export type AutoFromContent = AutoUserStopMsg | AutoUserIntervenedMsg;

// --- side panel -> SW -------------------------------------------------------

export interface AutoStartMsg {
  type: 'AUTO_START';
  config: RunConfig;
  /** Explicit target tab; defaults to the active tab. */
  tabId?: number;
}

export interface AutoPauseMsg {
  type: 'AUTO_PAUSE';
  runId: string;
}

export interface AutoResumeMsg {
  type: 'AUTO_RESUME';
  runId: string;
}

export interface AutoStopMsg {
  type: 'AUTO_STOP';
  runId: string;
}

export interface AutoConfirmationMsg {
  type: 'AUTO_CONFIRMATION';
  runId: string;
  approved: boolean;
  note?: string;
}

export interface AutoGetStateMsg {
  type: 'AUTO_GET_STATE';
}

export type AutoFromPanel =
  | AutoStartMsg
  | AutoPauseMsg
  | AutoResumeMsg
  | AutoStopMsg
  | AutoConfirmationMsg
  | AutoGetStateMsg;

// --- SW -> side panel (pushed on every state transition) ---------------------

export interface AutoStateMsg {
  type: 'AUTO_STATE';
  runId: string;
  status: RunStatus;
  phase: RunPhase;
  /** Pause/refusal/final detail, e.g. 'service_worker_restarted'. */
  detail?: string;
  trace: TraceStep[];
  budgets: BudgetSnapshot;
  /** Set once the run finalized via a `finish` action. */
  outcome?: 'pass' | 'fail' | 'blocked';
  reason?: string;
}

export type AutoMessage = AutoToContent | AutoFromContent | AutoFromPanel | AutoStateMsg;

/** Run state persisted to chrome.storage.session after every transition (§7.1). */
export interface PersistedAutoRun {
  runId: string;
  config: RunConfig;
  tabId: number;
  sessionId: string;
  status: RunStatus;
  phase: RunPhase;
  detail?: string;
  trace: TraceStep[];
  /** Verbatim in M2; deterministic compression lands in M3 (§7.5). */
  historyCompact: import('@qa-copilot/shared/auto').HistoryEntry[];
  budgets: {
    stepsUsed: number;
    llmCalls: number;
    startedAt: number;
    staleEpochRetries: number;
  };
  outcome?: 'pass' | 'fail' | 'blocked';
  reason?: string;
}

export function isAutoMessage(msg: { type?: unknown }): msg is AutoMessage {
  return typeof msg?.type === 'string' && msg.type.startsWith('AUTO_');
}
