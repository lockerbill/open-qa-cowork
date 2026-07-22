/**
 * Durable-selector recording at execution time (auto-test-mode-spec §6.4.6).
 * Wraps the EXISTING selector-priority ladder — the same one the manual
 * recorder uses — against the live element, BEFORE dispatch (the click may
 * destroy the node).
 */
import { redactText, selectorStrings } from '@qa-copilot/shared';
import { accessibleName, selectorInputFor } from '../element-extract.js';
import { capText } from './redact-node.js';

export interface RecordedSelector {
  /** Best candidate from the ladder (testid → role+name → … → xpath). */
  durableSelector?: string;
  /** Full candidate list, best first. */
  selectorCandidates: string[];
  /** Target element's text at execution time, redacted + capped. */
  elementText?: string;
}

export function recordSelector(el: Element): RecordedSelector {
  const selectorCandidates = selectorStrings(selectorInputFor(el));
  const rawText = accessibleName(el) ?? el.textContent?.trim() ?? '';
  return {
    durableSelector: selectorCandidates[0],
    selectorCandidates,
    elementText: rawText ? capText(redactText(rawText)) : undefined,
  };
}
