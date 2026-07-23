import { describe, expect, it } from 'vitest';
import type { TraceStep } from '@qa-copilot/shared/auto';
import type { BudgetSnapshot } from '../../background/auto/messages.js';
import { budgetBars, summarizeAction, toTimelineRow } from './run-view-logic.js';

function step(overrides: Partial<TraceStep>): TraceStep {
  return {
    step: 1,
    action: { type: 'click', index: 3, intent: 'open form' },
    result: 'ok',
    urlBefore: 'http://x/',
    urlAfter: 'http://x/',
    consoleErrors: [],
    failedRequests: [],
    startedAt: 0,
    endedAt: 100,
    ...overrides,
  };
}

describe('toTimelineRow (§10 timeline format)', () => {
  it('renders `#n [icon] intent — summary → result` parts for an ok click', () => {
    const row = toTimelineRow(step({ intent: 'open form' }));
    expect(row).toMatchObject({
      step: 1,
      icon: '🖱',
      intent: 'open form',
      summary: 'click [3]',
      result: 'ok',
      destructive: false,
    });
    expect(row.assertChip).toBeUndefined();
    expect(row.defect).toBeUndefined();
  });

  it('appends the detail for failed / refused / rejected results', () => {
    expect(toTimelineRow(step({ result: 'failed', resultDetail: 'covered: BUTTON' })).result).toBe(
      'failed (covered: BUTTON)',
    );
    expect(toTimelineRow(step({ result: 'refused', resultDetail: 'observe-only mode' })).result).toBe(
      'refused (observe-only mode)',
    );
    expect(
      toTimelineRow(step({ result: 'rejected_by_user', resultDetail: 'rejected: too risky' })).result,
    ).toBe('rejected_by_user (rejected: too risky)');
    expect(toTimelineRow(step({ result: 'confirmed_by_user' })).result).toBe('confirmed_by_user');
  });

  it('gives assert steps a pass/fail chip (§10)', () => {
    const assertion = (holds: boolean) =>
      toTimelineRow(
        step({ action: { type: 'assert', expectation: 'item visible', holds, evidence: 'list' } }),
      );
    expect(assertion(true).assertChip).toBe('pass');
    expect(assertion(false).assertChip).toBe('fail');
  });

  it('carries defect card fields for report_defect steps (§10)', () => {
    const row = toTimelineRow(
      step({
        action: {
          type: 'report_defect',
          severity: 'high',
          summary: 'Save returns 500',
          expected: 'item saved',
          actual: 'error toast',
        },
      }),
    );
    expect(row.icon).toBe('🐞');
    expect(row.defect).toEqual({
      severity: 'high',
      summary: 'Save returns 500',
      expected: 'item saved',
      actual: 'error toast',
    });
  });

  it('marks destructive-tagged steps', () => {
    expect(toTimelineRow(step({ destructive: true })).destructive).toBe(true);
  });
});

describe('summarizeAction', () => {
  it('renders the salient parameter per action type', () => {
    expect(summarizeAction({ type: 'fill', index: 2, value: 'abc', intent: 'x' })).toBe(
      'fill [2] "abc"',
    );
    expect(summarizeAction({ type: 'press', key: 'Enter', intent: 'x' })).toBe('press Enter');
    expect(summarizeAction({ type: 'scroll', direction: 'down', amount: 'page' })).toBe(
      'scroll down',
    );
    expect(summarizeAction({ type: 'wait', seconds: 3, reason: 'x' })).toBe('wait 3s');
    expect(summarizeAction({ type: 'finish', outcome: 'pass', reason: 'done' })).toBe('finish pass');
  });
});

describe('budgetBars', () => {
  const budgets: BudgetSnapshot = {
    stepsUsed: 5,
    maxSteps: 25,
    llmCalls: 6,
    maxLlmCalls: 35,
    elapsedMs: 90_000,
    maxWallClockMs: 600_000,
    staleEpochRetries: 0,
    correctionTurns: 0,
  };

  it('produces steps and time bars with rounded percentages', () => {
    expect(budgetBars(budgets)).toEqual([
      { label: 'Steps', used: 5, max: 25, pct: 20 },
      { label: 'Time', used: 90, max: 600, pct: 15 },
    ]);
  });

  it('clamps overshoot at 100%', () => {
    expect(budgetBars({ ...budgets, elapsedMs: 700_000 })[1]!.pct).toBe(100);
  });
});
