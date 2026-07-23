/**
 * Prompt assembly for POST /auto/step (auto-test-mode-spec §8.2). The system
 * prompt is checked into the repo (system-prompt.md, task 17.1); the user
 * message follows the fixed layout `<goal> <mode> <available_placeholders>
 * <history> <observation> <steps_remaining>`, with the observation wrapped in
 * the same untrusted-content delimiters suggest mode uses.
 *
 * Everything page-derived is re-redacted server-side (defense in depth) even
 * though the extension already redacts before sending.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from '@qa-copilot/shared';
import type { HistoryItem, StepRequest } from '@qa-copilot/shared/auto';
import { asUntrustedText } from '../../redaction/guard.js';

const SYSTEM_PROMPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'system-prompt.md'),
  'utf8',
);

export function autoStepSystem(): string {
  return SYSTEM_PROMPT;
}

/** One compact deterministic line per history item (entries and summaries). */
export function historyLine(item: HistoryItem): string {
  if ('kind' in item) {
    return `steps ${item.fromStep}-${item.toStep}: ${item.line}`;
  }
  const action = item.action;
  const parts: string[] = [action.type];
  if ('index' in action) parts.push(`[${action.index}]`);
  if (action.type === 'fill') parts.push(`value=${JSON.stringify(action.value)}`);
  if (action.type === 'select') parts.push(`option=${JSON.stringify(action.option)}`);
  if (action.type === 'press') parts.push(action.key);
  if (action.type === 'scroll') parts.push(action.direction);
  if (action.type === 'navigate') parts.push(action.url);
  if (action.type === 'assert') {
    parts.push(`"${action.expectation}"`, action.holds ? 'held' : 'DID NOT HOLD');
  }
  if (action.type === 'report_defect') parts.push(`"${action.summary}"`);
  if ('intent' in action && action.intent) parts.push(`(${action.intent})`);
  const detail = item.resultDetail ? `: ${item.resultDetail}` : '';
  const errors = item.newErrors > 0 ? ` [+${item.newErrors} console error(s)]` : '';
  return `step ${item.step}: ${parts.join(' ')} -> ${item.result}${detail}${errors}`;
}

/** The observation body: serialized snapshot plus step evidence (§8.2). */
function observationBody(request: StepRequest): string {
  const { observation } = request;
  const lines: string[] = [observation.serialized];
  if (observation.consoleErrors.length > 0) {
    lines.push(
      '<console_errors>',
      ...observation.consoleErrors.map((err) => `- ${err}`),
      '</console_errors>',
    );
  }
  if (observation.failedRequests.length > 0) {
    lines.push(
      '<failed_requests>',
      ...observation.failedRequests.map((r) => `- ${r.method} ${r.url} -> ${r.status}`),
      '</failed_requests>',
    );
  }
  return lines.join('\n');
}

/**
 * Build the user message (§8.2). `correction` (§8.5) renders as a final
 * history line so the model sees its invalid output in sequence.
 */
export function autoStepUser(request: StepRequest): string {
  const historyLines = request.history.map(historyLine);
  if (request.correction) {
    historyLines.push(
      `system: your previous output was invalid: ${request.correction}. Emit exactly one valid action.`,
    );
  }
  return [
    `<goal>\n${request.goal}\n</goal>`,
    `<mode>${request.mode}</mode>`,
    `<available_placeholders>${request.placeholders.join(', ')}</available_placeholders>`,
    `<history>\n${historyLines.length > 0 ? historyLines.join('\n') : '(no steps yet)'}\n</history>`,
    asUntrustedText('observation', redactText(observationBody(request))),
    `<steps_remaining>${request.stepsRemaining}</steps_remaining>`,
  ].join('\n');
}

/**
 * JSON-only response-format instruction appended for providers without tool
 * support (§8.3). The action vocabulary itself lives in the system prompt.
 */
export const JSON_MODE_INSTRUCTION =
  'Respond with ONLY the JSON object for your single next action, e.g. ' +
  '{"type": "click", "index": 3, "intent": "open the form"}. No prose, no markdown fences.';
