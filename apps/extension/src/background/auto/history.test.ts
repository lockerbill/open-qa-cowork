/**
 * Task 18.4 (history part, §7.5/§13.1): 40-entry history → last 12 verbatim,
 * older entries summarized deterministically per 5 steps, full StepRequest
 * within the ~6k-token target.
 */
import { describe, expect, it } from 'vitest';
import type {
  HistoryEntry,
  HistorySummary,
  Observation,
  StepRequest,
} from '@qa-copilot/shared/auto';
import { zStepRequest } from '@qa-copilot/shared/auto';
import { compressHistory } from './history.js';

function makeEntry(step: number): HistoryEntry {
  return {
    step,
    action: {
      type: 'click',
      index: step % 7,
      intent: `open panel number ${step} to inspect its contents`,
    },
    result: step % 9 === 0 ? 'failed' : 'ok',
    ...(step % 9 === 0 ? { resultDetail: 'covered: cookie banner' } : {}),
    urlAfter: `http://localhost:5555/auto-playground.html?step=${step}`,
    newErrors: 0,
  };
}

const entries = (n: number) => Array.from({ length: n }, (_, i) => makeEntry(i + 1));

/** A realistic mid-size observation (~150 elements would be the cap; use 60). */
function makeObservation(): Observation {
  const serialized = Array.from(
    { length: 60 },
    (_, i) => `[${i}]<button data-test="row-${i}" >Playground action button ${i} />`,
  ).join('\n');
  return {
    url: 'http://localhost:5555/auto-playground.html',
    title: 'Playground',
    pageInfo: {
      viewportWidth: 1280,
      viewportHeight: 800,
      pageWidth: 1280,
      pageHeight: 3200,
      pixelsAbove: 0,
      pixelsBelow: 2400,
      scrollPositionPct: 0,
    },
    activeDialog: null,
    serialized,
    elementCount: 60,
    consoleErrors: [],
    failedRequests: [],
    navigationOccurred: false,
    timestamp: 1700000000000,
    epoch: 41,
  };
}

describe('compressHistory (§7.5)', () => {
  it('passes through verbatim at or below 20 entries', () => {
    const input = entries(20);
    expect(compressHistory(input)).toEqual(input);
  });

  it('keeps the last 12 verbatim and summarizes older entries per 5 steps', () => {
    const input = entries(40);
    const items = compressHistory(input);

    // 28 older entries → 6 summary chunks (5×5 + 1×3), then 12 verbatim.
    expect(items).toHaveLength(6 + 12);
    expect(items.slice(6)).toEqual(input.slice(28));

    const summaries = items.slice(0, 6) as HistorySummary[];
    expect(summaries.every((s) => s.kind === 'summary')).toBe(true);
    expect(summaries[0]).toMatchObject({ fromStep: 1, toStep: 5 });
    expect(summaries[5]).toMatchObject({ fromStep: 26, toStep: 28 });
    // Deterministic digest built from the entries — intents and failures show.
    expect(summaries[0]!.line).toContain('clicked');
    expect(summaries[1]!.line).toContain('-> failed'); // step 9 failed
  });

  it('keeps a 40-entry StepRequest under the ~6k-token target', () => {
    const request: StepRequest = {
      goal: 'explore the playground and verify item creation works',
      mode: 'observe_only',
      history: compressHistory(entries(40)),
      observation: makeObservation(),
      stepsRemaining: 20,
      placeholders: ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD'],
    };
    // ~4 chars per token: 6k tokens ≈ 24k chars.
    expect(JSON.stringify(request).length).toBeLessThan(24_000);
    // The compressed request still satisfies the shared contract.
    expect(zStepRequest.safeParse(request).success).toBe(true);
  });
});
