/**
 * Deterministic history compression (auto-test-mode-spec §7.5): StepRequest
 * history stays compact HistoryEntry records; beyond 20 entries the last 12
 * remain verbatim and older entries are summarized into one synthetic line per
 * 5 steps — produced from the entries themselves, never by an LLM call. Target:
 * a full StepRequest under ~6k tokens for 8k-context local models.
 */
import type { HistoryEntry, HistoryItem, HistorySummary } from '@qa-copilot/shared/auto';

const VERBATIM_TAIL = 12;
const COMPRESS_THRESHOLD = 20;
const CHUNK_SIZE = 5;
const LINE_CAP = 240;

/** One short verb phrase per entry, preferring the model's own intent. */
function describeEntry(entry: HistoryEntry): string {
  const action = entry.action;
  const intent = 'intent' in action && typeof action.intent === 'string' ? action.intent : '';
  const base = (() => {
    switch (action.type) {
      case 'click':
        return intent ? `clicked "${intent}"` : `clicked [${action.index}]`;
      case 'fill':
        return intent ? `filled "${intent}"` : `filled [${action.index}]`;
      case 'select':
        return `selected "${action.option}"`;
      case 'press':
        return `pressed ${action.key}`;
      case 'scroll':
        return `scrolled ${action.direction}`;
      case 'navigate':
        return `navigated to ${action.url}`;
      case 'wait':
        return 'waited';
      case 'assert':
        return `asserted "${action.expectation}" (${action.holds ? 'held' : 'did not hold'})`;
      case 'report_defect':
        return `reported defect "${action.summary}"`;
      case 'finish':
        return 'finished';
      default:
        return String((action as { type: string }).type);
    }
  })();
  return entry.result === 'ok' ? base : `${base} -> ${entry.result}`;
}

function summarize(chunk: HistoryEntry[]): HistorySummary {
  const notOk = chunk.filter((entry) => entry.result !== 'ok').length;
  const suffix = notOk === 0 ? ' (all ok)' : '';
  const line = `${chunk.map(describeEntry).join(', ')}${suffix}`;
  return {
    kind: 'summary',
    fromStep: chunk[0]!.step,
    toStep: chunk[chunk.length - 1]!.step,
    line: line.length > LINE_CAP ? `${line.slice(0, LINE_CAP - 1)}…` : line,
  };
}

/**
 * Compress a run's history for the next StepRequest. At or below the
 * threshold the entries pass through verbatim.
 */
export function compressHistory(entries: HistoryEntry[]): HistoryItem[] {
  if (entries.length <= COMPRESS_THRESHOLD) return [...entries];
  const older = entries.slice(0, entries.length - VERBATIM_TAIL);
  const tail = entries.slice(entries.length - VERBATIM_TAIL);
  const summaries: HistoryItem[] = [];
  for (let i = 0; i < older.length; i += CHUNK_SIZE) {
    summaries.push(summarize(older.slice(i, i + CHUNK_SIZE)));
  }
  return [...summaries, ...tail];
}
