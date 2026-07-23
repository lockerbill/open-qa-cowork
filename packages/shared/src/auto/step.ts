/**
 * Step request/response between the service worker and POST /auto/step
 * (auto-test-mode-spec §5.3). The server is stateless: everything it needs to
 * decide the next action travels in the StepRequest. The zod schemas validate
 * the request body on the server and in the stub decider (§8, §13.2).
 */
import { z } from 'zod';
import { zAction, type Action } from './action.js';
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

/**
 * One deterministic digest line replacing 5 older history entries (§7.5).
 * Produced by the SW's history compression — never by an LLM call.
 */
export interface HistorySummary {
  kind: 'summary';
  fromStep: number;
  toStep: number;
  /** e.g. `steps 1–5: clicked "Add item", filled item-name (all ok)`. */
  line: string;
}

export type HistoryItem = HistoryEntry | HistorySummary;

export interface StepRequest {
  /** Fixed at run start; NEVER updated from page content. */
  goal: string;
  mode: RunMode;
  /** Compressed per §7.5: older entries become HistorySummary lines. */
  history: HistoryItem[];
  /** Current, full. */
  observation: Observation;
  stepsRemaining: number;
  /** Available credential placeholder NAMES only, e.g. ["TEST_USER_EMAIL"]. */
  placeholders: string[];
  language?: string;
  /**
   * Correction turn (§8.5): set by the SW when the previous response for this
   * same request was invalid. The server appends it to the prompt as a system
   * note; the request is otherwise identical to the failed attempt.
   */
  correction?: string;
}

export interface StepResponse {
  action: Action;
  /** Debug only, behind server flag. */
  modelRaw?: string;
}

// --- zod schemas (task 15.2) -------------------------------------------------
// Used for request validation on the server AND by the stub decider, so both
// gate on the identical contract. Kept in this file (not observation.ts) so the
// pure-type modules stay free of runtime imports — content-script code must
// only ever `import type` from this package (M1 chunk-graph note).

export const zObservation = z.object({
  url: z.string(),
  title: z.string(),
  pageInfo: z.object({
    viewportWidth: z.number(),
    viewportHeight: z.number(),
    pageWidth: z.number(),
    pageHeight: z.number(),
    pixelsAbove: z.number(),
    pixelsBelow: z.number(),
    scrollPositionPct: z.number(),
  }),
  activeDialog: z.string().nullable(),
  serialized: z.string(),
  elementCount: z.number().int(),
  consoleErrors: z.array(z.string()),
  failedRequests: z.array(
    z.object({ method: z.string(), url: z.string(), status: z.number() }),
  ),
  navigationOccurred: z.boolean(),
  timestamp: z.number(),
  epoch: z.number().int(),
});

export const zHistoryEntry = z.object({
  // History records what HAPPENED — including model output that failed zAction
  // validation (result 'failed', detail 'model_output_invalid'), preserved so
  // the model can see its mistake (§8.5). Only StepResponse actions are
  // strictly validated; history tolerates any `{type: string}` shape.
  step: z.number().int(),
  action: z.union([zAction, z.object({ type: z.string() }).passthrough()]),
  result: z.enum(['ok', 'failed', 'refused', 'confirmed_by_user', 'rejected_by_user']),
  resultDetail: z.string().optional(),
  urlAfter: z.string(),
  newErrors: z.number(),
});

export const zHistorySummary = z.object({
  kind: z.literal('summary'),
  fromStep: z.number().int(),
  toStep: z.number().int(),
  line: z.string(),
});

export const zHistoryItem = z.union([zHistorySummary, zHistoryEntry]);

export const zStepRequest = z.object({
  goal: z.string().min(1),
  mode: z.enum(['observe_only', 'confirm', 'autonomous']),
  history: z.array(zHistoryItem),
  observation: zObservation,
  stepsRemaining: z.number().int(),
  placeholders: z.array(z.string()),
  language: z.string().optional(),
  correction: z.string().max(500).optional(),
});

export const zStepResponse = z.object({
  action: zAction,
  modelRaw: z.string().optional(),
});
