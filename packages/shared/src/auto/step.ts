/**
 * Step request/response between the service worker and POST /auto/step
 * (auto-test-mode-spec §5.3). The server is stateless: everything it needs to
 * decide the next action travels in the StepRequest.
 */
import type { Action } from './action.js';
import type { Observation } from './observation.js';

export type StepResult = 'ok' | 'failed' | 'refused' | 'confirmed_by_user' | 'rejected_by_user';

export type RunMode = 'observe_only' | 'confirm' | 'autonomous';

/** Compact — full observation is NOT retained per step. */
export interface HistoryEntry {
  step: number;
  action: Action;
  result: StepResult;
  /** Error reason / refusal reason, capped 200 chars. */
  resultDetail?: string;
  urlAfter: string;
  /** Console errors that appeared during this step. */
  newErrors: number;
}

export interface StepRequest {
  /** Fixed at run start; NEVER updated from page content. */
  goal: string;
  mode: RunMode;
  /** Compressed per §7.5. */
  history: HistoryEntry[];
  /** Current, full. */
  observation: Observation;
  stepsRemaining: number;
  /** Available credential placeholder NAMES only, e.g. ["TEST_USER_EMAIL"]. */
  placeholders: string[];
  language?: string;
}

export interface StepResponse {
  action: Action;
  /** Debug only, behind server flag. */
  modelRaw?: string;
}
