/**
 * Run configuration, status, trace, and result types
 * (auto-test-mode-spec §5.4). All run state lives in the extension service
 * worker; the trace is what the side panel renders and what persists with the
 * recorder session.
 */
import type { Action } from './action.js';
import type { Observation } from './observation.js';
import type { HistoryEntry, RunMode } from './step.js';

export interface RunConfig {
  goal: string;
  mode: RunMode;
  /** Default 25, hard cap 60. */
  maxSteps: number;
  /** Default 10 min. */
  maxWallClockMs: number;
  /** Default maxSteps + 10 (corrections). */
  maxLlmCalls: number;
  /** Origins; first entry = start origin. */
  originAllowlist: string[];
  /**
   * Base URL the service worker POSTs /auto/step against. Defaults to the
   * extension's configured backend; E2E points it at the stub decider (§13.2).
   */
  deciderBaseUrl?: string;
  debugHighlights?: boolean;
  /**
   * Deviation from spec §5.4 (`provider: ProviderRef`): the repo has no shared
   * provider config type — provider selection is server-side (legacy env
   * config) or workspace-scoped (gateway). An opaque reference is enough for
   * the server to resolve; unused until M3.
   */
  providerRef?: string;
}

export const RUN_DEFAULTS = {
  maxSteps: 25,
  maxStepsHardCap: 60,
  maxWallClockMs: 10 * 60 * 1000,
} as const;

export type RunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_confirmation'
  | 'paused'
  | 'finished'
  | 'stopped_by_user'
  | 'stopped_by_budget'
  | 'error';

export interface TraceStep {
  step: number;
  intent?: string;
  action: Action;
  result: HistoryEntry['result'];
  resultDetail?: string;
  /** Recorded by the selector recorder at execution time. */
  durableSelector?: string;
  /** Target element's text at execution time. */
  elementText?: string;
  urlBefore: string;
  urlAfter: string;
  consoleErrors: string[];
  failedRequests: Observation['failedRequests'];
  /** Set when the destructive-action policy matched in autonomous mode (§9.3). */
  destructive?: boolean;
  startedAt: number;
  endedAt: number;
}

export interface RunResult {
  status: RunStatus;
  outcome?: 'pass' | 'fail' | 'blocked';
  reason?: string;
  trace: TraceStep[];
  defects: Array<Extract<Action, { type: 'report_defect' }> & { step: number }>;
  assertions: Array<Extract<Action, { type: 'assert' }> & { step: number }>;
  /** The recorder session this run wrote into. */
  sessionId: string;
}
