/**
 * Auto Test Mode observation types (auto-test-mode-spec §5.1). Built by the
 * content-script observation builder, already redacted; `serialized` is the
 * only page representation the LLM ever reads.
 */

export interface PageInfo {
  viewportWidth: number;
  viewportHeight: number;
  pageWidth: number;
  pageHeight: number;
  pixelsAbove: number;
  pixelsBelow: number;
  /** 0..100 */
  scrollPositionPct: number;
}

export type ObservedElementState =
  | 'disabled'
  | 'checked'
  | 'expanded'
  | 'collapsed'
  | 'invalid'
  | 'required'
  | 'readonly'
  | 'new';

export interface ObservedElement {
  /** The ONLY handle the LLM may use to target this element. */
  index: number;
  tag: string;
  role?: string;
  /** Accessible name / visible text, capped 120 chars, redacted. */
  text: string;
  /** Filtered by allowlist, redacted. */
  attributes: Record<string, string>;
  states: ObservedElementState[];
  /** password/OTP/etc — value never shown, fill only via placeholder. */
  isSecret: boolean;
}

export interface Observation {
  url: string;
  title: string;
  pageInfo: PageInfo;
  /** Accessible name of topmost open dialog, if any. */
  activeDialog: string | null;
  /** flatTreeToString output (redacted) — what the LLM reads. */
  serialized: string;
  /** Number of interactive elements in this snapshot. */
  elementCount: number;
  /** Captured since previous observation, capped 10 × 300 chars. */
  consoleErrors: string[];
  /** 4xx/5xx/network-error, capped 10. */
  failedRequests: Array<{ method: string; url: string; status: number }>;
  /** Page navigated since last step. */
  navigationOccurred: boolean;
  timestamp: number;
  /** Increments every observation; guards stale execution (§6.4). */
  epoch: number;
}
