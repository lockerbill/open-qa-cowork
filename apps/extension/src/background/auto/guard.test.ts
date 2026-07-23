/**
 * Task 19.2: observe-only mode-gate matrix (§9.2) including the
 * click-on-link/tab carve-out. The refusal-recorded-in-history path is covered
 * in run-controller.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Action, ObservedElement, RunConfig } from '@qa-copilot/shared/auto';
import { checkAction } from './guard.js';

const ORIGIN = 'http://localhost:5555';

function config(mode: RunConfig['mode']): RunConfig {
  return {
    goal: 'explore',
    mode,
    maxSteps: 25,
    maxWallClockMs: 600_000,
    maxLlmCalls: 35,
    originAllowlist: [ORIGIN],
  };
}

function element(overrides: Partial<ObservedElement>): ObservedElement {
  return {
    index: 0,
    tag: 'button',
    text: 'Do it',
    attributes: {},
    states: [],
    isSecret: false,
    ...overrides,
  };
}

const REFUSED = { verdict: 'refuse', reason: 'observe-only mode' };
const ALLOWED = { verdict: 'allow' };

describe('observe-only mode gate (§9.2)', () => {
  const cfg = config('observe_only');

  it('allows the read-only action set', () => {
    const allowed: Action[] = [
      { type: 'scroll', direction: 'down', amount: 'page' },
      { type: 'wait', seconds: 2, reason: 'spinner' },
      { type: 'assert', expectation: 'list shown', holds: true, evidence: 'list [3]' },
      { type: 'report_defect', severity: 'low', summary: 's', expected: 'e', actual: 'a' },
      { type: 'finish', outcome: 'pass', reason: 'done' },
      { type: 'press', key: 'Escape', intent: 'close dialog' },
    ];
    for (const action of allowed) {
      expect(checkAction(action, [], cfg), action.type).toEqual(ALLOWED);
    }
  });

  it('refuses fill, select, and non-Escape presses', () => {
    const refused: Action[] = [
      { type: 'fill', index: 0, value: 'x', intent: 'type' },
      { type: 'select', index: 0, option: 'A', intent: 'pick' },
      { type: 'press', key: 'Enter', intent: 'submit' },
      { type: 'press', key: 'Tab', intent: 'move focus' },
    ];
    for (const action of refused) {
      expect(checkAction(action, [element({})], cfg), action.type).toEqual(REFUSED);
    }
  });

  it('allows clicks only on link/tab/aria-expanded elements (carve-out)', () => {
    const click: Action = { type: 'click', index: 0, intent: 'open' };
    // Read-only-ish navigation targets.
    expect(checkAction(click, [element({ role: 'link' })], cfg)).toEqual(ALLOWED);
    expect(checkAction(click, [element({ role: 'tab' })], cfg)).toEqual(ALLOWED);
    expect(checkAction(click, [element({ tag: 'a' })], cfg)).toEqual(ALLOWED);
    expect(
      checkAction(click, [element({ attributes: { 'aria-expanded': 'false' } })], cfg),
    ).toEqual(ALLOWED);
    expect(checkAction(click, [element({ states: ['expanded'] })], cfg)).toEqual(ALLOWED);
    expect(checkAction(click, [element({ states: ['collapsed'] })], cfg)).toEqual(ALLOWED);
    // Plain buttons mutate the app — refused.
    expect(checkAction(click, [element({})], cfg)).toEqual(REFUSED);
    // Metadata-less target: cannot verify the carve-out — refused.
    expect(checkAction(click, [], cfg)).toEqual(REFUSED);
    // Index mismatch: the clicked element is not the link.
    expect(checkAction(click, [element({ index: 5, role: 'link' })], cfg)).toEqual(REFUSED);
  });

  it('refuses navigate in observe-only even when same-origin', () => {
    const nav: Action = { type: 'navigate', url: `${ORIGIN}/second.html`, intent: 'go' };
    expect(checkAction(nav, [], cfg)).toEqual(REFUSED);
    // Off-origin still hits the origin lock first (check order).
    const offOrigin: Action = { type: 'navigate', url: 'https://evil.example/x', intent: 'go' };
    expect(checkAction(offOrigin, [], cfg)).toEqual({
      verdict: 'refuse',
      reason: 'navigation outside allowed origin',
    });
  });

  it('does not gate confirm or autonomous modes', () => {
    for (const mode of ['confirm', 'autonomous'] as const) {
      const cfg2 = config(mode);
      expect(checkAction({ type: 'fill', index: 0, value: 'x', intent: 't' }, [], cfg2)).toEqual(
        ALLOWED,
      );
      expect(checkAction({ type: 'click', index: 0, intent: 'c' }, [element({})], cfg2)).toEqual(
        ALLOWED,
      );
    }
  });
});
