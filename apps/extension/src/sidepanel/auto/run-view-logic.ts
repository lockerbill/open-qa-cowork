/**
 * Pure run-view logic for the Auto tab (auto-test-mode-spec §10): timeline row
 * shaping (`#n [icon] intent — action summary → result`), assert chips, defect
 * cards, and budget-bar math. Chrome-free and React-free for unit testing.
 */
import type { Action, TraceStep } from '@qa-copilot/shared/auto';
import type { BudgetSnapshot } from '../../background/auto/messages.js';

const ACTION_ICONS: Record<string, string> = {
  click: '🖱',
  fill: '⌨',
  select: '☑',
  press: '⏎',
  scroll: '↕',
  navigate: '🔗',
  wait: '⏳',
  assert: '🔍',
  report_defect: '🐞',
  finish: '🏁',
};

/** Human-readable one-liner of an action (also used by the confirmation modal). */
export function summarizeAction(action: Action | Record<string, unknown>): string {
  const a = action as Record<string, unknown>;
  const parts: string[] = [String(a.type)];
  if (typeof a.index === 'number') parts.push(`[${a.index}]`);
  if (typeof a.key === 'string') parts.push(a.key);
  if (typeof a.direction === 'string') parts.push(String(a.direction));
  if (typeof a.value === 'string') parts.push(JSON.stringify(a.value));
  if (typeof a.option === 'string') parts.push(JSON.stringify(a.option));
  if (typeof a.url === 'string') parts.push(String(a.url));
  if (typeof a.seconds === 'number') parts.push(`${a.seconds}s`);
  if (typeof a.expectation === 'string') parts.push(JSON.stringify(a.expectation));
  if (typeof a.summary === 'string') parts.push(JSON.stringify(a.summary));
  if (typeof a.outcome === 'string') parts.push(String(a.outcome));
  return parts.join(' ');
}

export interface TimelineRow {
  step: number;
  icon: string;
  intent?: string;
  summary: string;
  /** `→ result` suffix, e.g. `ok`, `refused (observe-only mode)`. */
  result: string;
  /** Assert steps get a pass/fail chip (§10). */
  assertChip?: 'pass' | 'fail';
  /** report_defect steps render as a red defect card (§10). */
  defect?: { severity: string; summary: string; expected: string; actual: string };
  destructive: boolean;
}

/** `#n [icon] intent — action summary → result` (§10). */
export function toTimelineRow(step: TraceStep): TimelineRow {
  const action = step.action as Action;
  return {
    step: step.step,
    icon: ACTION_ICONS[action.type] ?? '•',
    ...(step.intent !== undefined && { intent: step.intent }),
    summary: summarizeAction(action),
    result: step.resultDetail ? `${step.result} (${step.resultDetail})` : step.result,
    ...(action.type === 'assert' && { assertChip: action.holds ? ('pass' as const) : ('fail' as const) }),
    ...(action.type === 'report_defect' && {
      defect: {
        severity: action.severity,
        summary: action.summary,
        expected: action.expected,
        actual: action.actual,
      },
    }),
    destructive: step.destructive === true,
  };
}

export interface BudgetBar {
  label: string;
  used: number;
  max: number;
  /** 0–100, clamped. */
  pct: number;
}

export function budgetBars(budgets: BudgetSnapshot): BudgetBar[] {
  const bar = (label: string, used: number, max: number): BudgetBar => ({
    label,
    used,
    max,
    pct: max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0,
  });
  return [
    bar('Steps', budgets.stepsUsed, budgets.maxSteps),
    bar('Time', Math.round(budgets.elapsedMs / 1000), Math.round(budgets.maxWallClockMs / 1000)),
  ];
}
