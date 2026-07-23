/**
 * Tasks 19.2 / 21.3 / 22.4: the guard matrix — observe-only mode gate (§9.2)
 * with the click-on-link/tab carve-out, destructive-action policy (§9.3)
 * across mode × action × match × metadata, and credential hygiene (§9.4). The
 * refusal-recorded-in-history path is covered in run-controller.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Action, ObservedElement, RunConfig } from '@qa-copilot/shared/auto';
import { checkAction, substituteCredentials } from './guard.js';

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

// --- 21.3 destructive-action policy (§9.3) ----------------------------------

describe('destructive-action policy (§9.3)', () => {
  const CLICK: Action = { type: 'click', index: 0, intent: 'click it' };
  const deleteBtn = element({ text: 'Delete item' });
  const safeBtn = element({ text: 'Add item' });

  it('policy matrix: mode × action × destructive-match × origin — every cell', () => {
    const rows: Array<{
      mode: RunConfig['mode'];
      action: Action;
      elements: ObservedElement[];
      want: ReturnType<typeof checkAction>;
    }> = [
      // click on destructive-matching element
      { mode: 'autonomous', action: CLICK, elements: [deleteBtn], want: { verdict: 'allow', destructive: true } },
      { mode: 'confirm', action: CLICK, elements: [deleteBtn], want: { verdict: 'confirm', reason: 'matches destructive pattern: "delete item"', destructive: true } },
      // observe_only: mode gate wins before the destructive check
      { mode: 'observe_only', action: CLICK, elements: [deleteBtn], want: { verdict: 'refuse', reason: 'observe-only mode' } },
      // click on a safe element
      { mode: 'autonomous', action: CLICK, elements: [safeBtn], want: { verdict: 'allow' } },
      { mode: 'confirm', action: CLICK, elements: [safeBtn], want: { verdict: 'allow' } },
      // aria-label / title carry the match too
      { mode: 'confirm', action: CLICK, elements: [element({ text: '🗑', attributes: { 'aria-label': 'Remove entry' } })], want: { verdict: 'confirm', reason: 'matches destructive pattern: "🗑 remove entry"', destructive: true } },
      { mode: 'confirm', action: CLICK, elements: [element({ text: 'X', attributes: { title: 'Destroy workspace' } })], want: { verdict: 'confirm', reason: 'matches destructive pattern: "x destroy workspace"', destructive: true } },
      // metadata-less click: destructive in confirm mode, allowed untagged in autonomous
      { mode: 'confirm', action: CLICK, elements: [], want: { verdict: 'confirm', reason: 'target element cannot be verified; treated as destructive' } },
      { mode: 'autonomous', action: CLICK, elements: [], want: { verdict: 'allow' } },
      // press Enter: focused element unknown to the SW → metadata-less rule
      { mode: 'confirm', action: { type: 'press', key: 'Enter', intent: 'submit' }, elements: [safeBtn], want: { verdict: 'confirm', reason: 'target element cannot be verified; treated as destructive' } },
      { mode: 'autonomous', action: { type: 'press', key: 'Enter', intent: 'submit' }, elements: [safeBtn], want: { verdict: 'allow' } },
      // other presses are not in the destructive action set
      { mode: 'confirm', action: { type: 'press', key: 'Tab', intent: 'move' }, elements: [], want: { verdict: 'allow' } },
      // navigate: URL matched; on-origin so the origin lock passes first
      { mode: 'confirm', action: { type: 'navigate', url: `${ORIGIN}/delete-account`, intent: 'go' }, elements: [], want: { verdict: 'confirm', reason: `matches destructive pattern: "${ORIGIN}/delete-account"`, destructive: true } },
      { mode: 'autonomous', action: { type: 'navigate', url: `${ORIGIN}/delete-account`, intent: 'go' }, elements: [], want: { verdict: 'allow', destructive: true } },
      { mode: 'confirm', action: { type: 'navigate', url: `${ORIGIN}/settings`, intent: 'go' }, elements: [], want: { verdict: 'allow' } },
      // origin lock still wins over everything (check order)
      { mode: 'confirm', action: { type: 'navigate', url: 'https://evil.example/delete', intent: 'go' }, elements: [], want: { verdict: 'refuse', reason: 'navigation outside allowed origin' } },
      // non-destructive action types never match
      { mode: 'confirm', action: { type: 'fill', index: 0, value: 'delete', intent: 't' }, elements: [deleteBtn], want: { verdict: 'allow' } },
      { mode: 'autonomous', action: { type: 'scroll', direction: 'down', amount: 'page' }, elements: [deleteBtn], want: { verdict: 'allow' } },
    ];
    for (const [i, row] of rows.entries()) {
      expect(
        checkAction(row.action, row.elements, config(row.mode)),
        `row ${i}: ${row.mode} ${row.action.type}`,
      ).toEqual(row.want);
    }
  });

  it('honors a per-run destructivePatterns override', () => {
    const cfg = { ...config('confirm'), destructivePatterns: ['\\bfrobnicate\\b'] };
    expect(checkAction(CLICK, [element({ text: 'Frobnicate DB' })], cfg)).toEqual({
      verdict: 'confirm',
      reason: 'matches destructive pattern: "frobnicate db"',
      destructive: true,
    });
    // The shared defaults no longer apply when overridden.
    expect(checkAction(CLICK, [deleteBtn], cfg)).toEqual({ verdict: 'allow' });
  });
});

// --- 22.4 credential hygiene (§9.4) -----------------------------------------

describe('credential hygiene (§9.4)', () => {
  const secretField = element({ tag: 'input', text: '', isSecret: true });
  const plainField = element({ tag: 'input', text: '' });
  const VAULT = ['TEST_USER_PASSWORD', 'TEST_USER_EMAIL'];
  const cfg = config('autonomous');
  const fill = (value: string): Action => ({ type: 'fill', index: 0, value, intent: 'type' });

  it('refuses a literal value on a secret field', () => {
    expect(checkAction(fill('hunter2'), [secretField], cfg, VAULT)).toEqual({
      verdict: 'refuse',
      reason: 'secret fields accept placeholders only',
    });
    // A placeholder embedded in other text is not exclusive → still refused.
    expect(checkAction(fill('x{{TEST_USER_PASSWORD}}'), [secretField], cfg, VAULT)).toEqual({
      verdict: 'refuse',
      reason: 'secret fields accept placeholders only',
    });
  });

  it('refuses an unknown placeholder, listing the available names', () => {
    expect(checkAction(fill('{{NOPE}}'), [secretField], cfg, VAULT)).toEqual({
      verdict: 'refuse',
      reason: 'unknown placeholder {{NOPE}}; available: TEST_USER_PASSWORD, TEST_USER_EMAIL',
    });
    expect(checkAction(fill('user {{NOPE}} x'), [plainField], cfg, [])).toEqual({
      verdict: 'refuse',
      reason: 'unknown placeholder {{NOPE}}; available: (none)',
    });
  });

  it('allows a known exclusive placeholder on a secret field and known tokens elsewhere', () => {
    expect(checkAction(fill('{{TEST_USER_PASSWORD}}'), [secretField], cfg, VAULT)).toEqual(ALLOWED);
    expect(checkAction(fill('hello {{TEST_USER_EMAIL}}'), [plainField], cfg, VAULT)).toEqual(
      ALLOWED,
    );
    // Plain literal into a non-secret field is fine.
    expect(checkAction(fill('just text'), [plainField], cfg, [])).toEqual(ALLOWED);
  });

  it('substituteCredentials replaces known tokens only, and only for fill', () => {
    const vault = { TEST_USER_PASSWORD: 's3cret!' };
    expect(substituteCredentials(fill('{{TEST_USER_PASSWORD}}'), vault)).toEqual(
      fill('s3cret!'),
    );
    expect(substituteCredentials(fill('a {{UNKNOWN}} b'), vault)).toEqual(fill('a {{UNKNOWN}} b'));
    const click: Action = { type: 'click', index: 0, intent: 'c' };
    expect(substituteCredentials(click, vault)).toBe(click);
    // Untouched fill returns the same object (no needless copies).
    const plain = fill('nothing here');
    expect(substituteCredentials(plain, vault)).toBe(plain);
  });
});
