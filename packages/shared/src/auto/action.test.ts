import { describe, it, expect } from 'vitest';
import { zAction } from './action.js';

describe('zAction (auto-test-mode-spec §5.2)', () => {
  it('accepts every valid action type', () => {
    const valid = [
      { type: 'click', index: 3, intent: 'open the login form' },
      { type: 'fill', index: 0, value: '{{TEST_USER_EMAIL}}', intent: 'enter email' },
      { type: 'select', index: 2, option: 'Belgium', intent: 'pick country' },
      { type: 'press', key: 'Enter', intent: 'submit the form' },
      { type: 'scroll', direction: 'down', amount: 'page' },
      { type: 'navigate', url: 'http://localhost:5555/spa.html', intent: 'go back to start' },
      { type: 'wait', seconds: 2, reason: 'spinner visible' },
      { type: 'assert', expectation: 'dashboard heading shown', holds: true, evidence: 'heading [4] reads Dashboard' },
      { type: 'report_defect', severity: 'high', summary: 'save 500s', expected: 'saved', actual: 'HTTP 500' },
      { type: 'finish', outcome: 'pass', reason: 'login flow verified' },
    ];
    for (const action of valid) {
      const parsed = zAction.safeParse(action);
      expect(parsed.success, `${action.type} should parse`).toBe(true);
    }
  });

  it('defaults scroll amount to page', () => {
    const parsed = zAction.safeParse({ type: 'scroll', direction: 'up' });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'scroll') {
      expect(parsed.data.amount).toBe('page');
    }
  });

  it('rejects unknown action types (no free-form JS action)', () => {
    expect(zAction.safeParse({ type: 'execute_js', code: 'alert(1)' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'hover', index: 1 }).success).toBe(false);
  });

  it('rejects click without an integer index', () => {
    expect(zAction.safeParse({ type: 'click', intent: 'x' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'click', index: 1.5, intent: 'x' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'click', index: -1, intent: 'x' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'click', index: '3', intent: 'x' }).success).toBe(false);
  });

  it('rejects missing required companion fields', () => {
    expect(zAction.safeParse({ type: 'fill', index: 0, intent: 'x' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'select', index: 0, intent: 'x' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'assert', expectation: 'e', holds: true }).success).toBe(false);
    expect(zAction.safeParse({ type: 'finish', outcome: 'pass' }).success).toBe(false);
  });

  it('rejects out-of-range and out-of-enum values', () => {
    expect(zAction.safeParse({ type: 'wait', seconds: 0.5, reason: 'r' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'wait', seconds: 9, reason: 'r' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'press', key: 'F5', intent: 'x' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'scroll', direction: 'left' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'report_defect', severity: 'catastrophic', summary: 's', expected: 'e', actual: 'a' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'navigate', url: 'not-a-url', intent: 'x' }).success).toBe(false);
  });

  it('rejects over-length strings', () => {
    const long = 'x'.repeat(2001);
    expect(zAction.safeParse({ type: 'fill', index: 0, value: long, intent: 'x' }).success).toBe(false);
    expect(zAction.safeParse({ type: 'click', index: 0, intent: 'i'.repeat(201) }).success).toBe(false);
    expect(zAction.safeParse({ type: 'finish', outcome: 'fail', reason: 'r'.repeat(501) }).success).toBe(false);
  });
});
