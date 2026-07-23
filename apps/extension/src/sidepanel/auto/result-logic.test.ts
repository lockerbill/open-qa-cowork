import { describe, expect, it } from 'vitest';
import type { RunResult, TraceStep } from '@qa-copilot/shared/auto';
import {
  assertionSummary,
  buildDefectPrefill,
  defectNoteText,
  metricsRows,
} from './result-logic.js';

function trace(step: number, action: TraceStep['action'], result: TraceStep['result'] = 'ok'): TraceStep {
  return {
    step,
    action,
    result,
    urlBefore: 'http://x/',
    urlAfter: 'http://x/',
    consoleErrors: [],
    failedRequests: [],
    startedAt: step * 1000,
    endedAt: step * 1000 + 500,
  };
}

const DEFECT = {
  type: 'report_defect' as const,
  severity: 'high' as const,
  summary: 'Save returns 500',
  expected: 'item saved',
  actual: 'error toast',
};

function result(overrides: Partial<RunResult>): RunResult {
  return {
    status: 'finished',
    trace: [],
    defects: [],
    assertions: [],
    sessionId: 'session_1',
    ...overrides,
  };
}

describe('assertionSummary (§10)', () => {
  it('counts passed and failed assertions', () => {
    const r = result({
      assertions: [
        { type: 'assert', expectation: 'a', holds: true, evidence: '', step: 1 },
        { type: 'assert', expectation: 'b', holds: false, evidence: '', step: 2 },
        { type: 'assert', expectation: 'c', holds: true, evidence: '', step: 3 },
      ],
    });
    expect(assertionSummary(r)).toEqual({ passed: 2, failed: 1 });
  });
});

describe('metricsRows (§12)', () => {
  it('renders the full metrics panel when metrics are present', () => {
    const rows = metricsRows(
      result({
        outcome: 'pass',
        metrics: {
          steps: 7,
          llmCalls: 9,
          correctionTurns: 1,
          refusals: 2,
          confirmations: 1,
          wallClockMs: 42_000,
        },
      }),
    );
    expect(rows).toEqual([
      { label: 'Steps', value: '7' },
      { label: 'LLM calls', value: '9' },
      { label: 'Corrections', value: '1' },
      { label: 'Refusals', value: '2' },
      { label: 'Confirmations', value: '1' },
      { label: 'Wall clock', value: '42s' },
      { label: 'Outcome', value: 'pass' },
    ]);
  });

  it('derives what it can from the trace for pre-M5 persisted results', () => {
    const rows = metricsRows(
      result({
        trace: [trace(1, { type: 'scroll', direction: 'down', amount: 'page' })],
      }),
    );
    expect(rows).toEqual([
      { label: 'Steps', value: '1' },
      { label: 'Wall clock', value: '1s' },
    ]);
  });
});

describe('buildDefectPrefill (§11)', () => {
  it('maps defect fields and excerpts the trace up to the defect step', () => {
    const steps: TraceStep[] = [
      trace(1, { type: 'click', index: 0, intent: 'open' }),
      trace(2, { type: 'click', index: 1, intent: 'save' }, 'failed'),
      trace(3, DEFECT),
      trace(4, { type: 'finish', outcome: 'fail', reason: 'bug found' }),
    ];
    const r = result({ trace: steps, defects: [{ ...DEFECT, step: 3 }] });

    const prefill = buildDefectPrefill(r, r.defects[0]!);
    expect(prefill.summary).toBe('Save returns 500');
    expect(prefill.expected).toBe('item saved');
    expect(prefill.actual).toBe('error toast');
    const lines = prefill.traceExcerpt.split('\n');
    expect(lines).toHaveLength(3); // steps 1–3, not the finish after the defect
    expect(lines[0]).toBe('#1 click [0] → ok');
    expect(lines[1]).toBe('#2 click [1] → failed');
    expect(lines[2]).toContain('report_defect');
  });

  it('caps the excerpt at the last 8 steps', () => {
    const steps = Array.from({ length: 12 }, (_, i) =>
      trace(i + 1, { type: 'scroll', direction: 'down', amount: 'page' }),
    );
    steps.push(trace(13, DEFECT));
    const r = result({ trace: steps, defects: [{ ...DEFECT, step: 13 }] });
    const lines = buildDefectPrefill(r, r.defects[0]!).traceExcerpt.split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain('#6');
  });
});

describe('defectNoteText', () => {
  it('serializes the prefill into a readable generator note', () => {
    expect(
      defectNoteText({ summary: 's', expected: 'e', actual: 'a', traceExcerpt: '#1 x' }),
    ).toBe('Defect: s\nExpected: e\nActual: a');
  });
});
