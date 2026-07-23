/**
 * Pure result-view logic for the Auto tab (auto-test-mode-spec §10–§12):
 * metrics display rows, assertion summary, and the bug-report defect prefill
 * payload (§11). Chrome-free and React-free for unit testing.
 */
import type { RunResult } from '@qa-copilot/shared/auto';
import { summarizeAction } from './run-view-logic.js';

/** §11: the optional prefill the bug-report generator accepts. */
export interface DefectPrefill {
  summary: string;
  expected: string;
  actual: string;
  traceExcerpt: string;
}

/** `n passed / n failed` over the run's assert steps (§10). */
export function assertionSummary(result: RunResult): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const assertion of result.assertions) {
    if (assertion.holds) passed += 1;
    else failed += 1;
  }
  return { passed, failed };
}

/** Metrics panel rows (§12); derives what it can when `metrics` is absent (pre-M5 runs). */
export function metricsRows(result: RunResult): Array<{ label: string; value: string }> {
  const m = result.metrics;
  const wallClockMs =
    m?.wallClockMs ??
    (result.trace.length > 0
      ? result.trace[result.trace.length - 1]!.endedAt - result.trace[0]!.startedAt
      : 0);
  const rows = [
    { label: 'Steps', value: String(m?.steps ?? result.trace.length) },
    ...(m
      ? [
          { label: 'LLM calls', value: String(m.llmCalls) },
          { label: 'Corrections', value: String(m.correctionTurns) },
          { label: 'Refusals', value: String(m.refusals) },
          { label: 'Confirmations', value: String(m.confirmations) },
        ]
      : []),
    { label: 'Wall clock', value: `${Math.round(wallClockMs / 1000)}s` },
  ];
  if (result.outcome) rows.push({ label: 'Outcome', value: result.outcome });
  return rows;
}

/**
 * §11 defect card → bug-report prefill `{summary, expected, actual,
 * traceExcerpt}`. The excerpt is the last ≤ 8 trace lines up to and including
 * the defect's step, formatted like the run timeline.
 */
export function buildDefectPrefill(
  result: RunResult,
  defect: RunResult['defects'][number],
): DefectPrefill {
  const upTo = result.trace.filter((step) => step.step <= defect.step);
  const excerpt = upTo
    .slice(-8)
    .map(
      (step) =>
        `#${step.step} ${summarizeAction(step.action)} → ${step.result}${
          step.resultDetail ? ` (${step.resultDetail})` : ''
        }`,
    )
    .join('\n');
  return {
    summary: defect.summary,
    expected: defect.expected,
    actual: defect.actual,
    traceExcerpt: excerpt,
  };
}

/** Readable note prefill for the Generate tab's textarea. */
export function defectNoteText(prefill: DefectPrefill): string {
  return `Defect: ${prefill.summary}\nExpected: ${prefill.expected}\nActual: ${prefill.actual}`;
}
