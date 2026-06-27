import { describe, it, expect } from 'vitest';
import { buildPlaywrightSpec } from './playwright.js';
import type { ActionEvent, TestSession } from './types.js';

function session(events: ActionEvent[], overrides: Partial<TestSession> = {}): TestSession {
  return {
    id: 'session_1',
    startedAt: '2026-06-27T10:00:00Z',
    status: 'stopped',
    baseUrl: 'https://staging.example.com/orders/create',
    currentUrl: 'https://staging.example.com/orders/create',
    events,
    evidence: [],
    consoleErrors: [],
    networkFailures: [],
    ...overrides,
  };
}

const ev = (e: Partial<ActionEvent>): ActionEvent => ({
  id: 'event_1',
  sessionId: 'session_1',
  type: 'click',
  timestamp: '2026-06-27T10:01:00Z',
  ...e,
});

describe('buildPlaywrightSpec (spec §9.10)', () => {
  it('emits a goto and stable click step', () => {
    const spec = buildPlaywrightSpec(
      session([
        ev({
          id: 'e1',
          type: 'click',
          targetLabel: 'Submit',
          selectorCandidates: ["getByRole('button', { name: 'Submit' })"],
        }),
      ]),
    );
    expect(spec.content).toContain("await page.goto('https://staging.example.com/orders/create');");
    expect(spec.content).toContain("await page.getByRole('button', { name: 'Submit' }).click();");
    expect(spec.selectorWarnings).toHaveLength(0);
    expect(spec.filename.endsWith('.spec.ts')).toBe(true);
  });

  it('fills non-sensitive input values', () => {
    const spec = buildPlaywrightSpec(
      session([
        ev({
          id: 'e1',
          type: 'input',
          value: 'Acme Corp',
          selectorCandidates: ["getByLabel('Supplier')"],
        }),
      ]),
    );
    expect(spec.content).toContain("await page.getByLabel('Supplier').fill('Acme Corp');");
  });

  it('does not emit values for sensitive (unrecorded) inputs', () => {
    const spec = buildPlaywrightSpec(
      session([
        ev({ id: 'e1', type: 'input', selectorCandidates: ["getByLabel('Password')"] }),
      ]),
    );
    expect(spec.content).toContain('sensitive input was not recorded');
    expect(spec.content).toContain("await page.getByLabel('Password').fill('');");
  });

  it('flags fragile selectors with TODO + warning', () => {
    const spec = buildPlaywrightSpec(
      session([
        ev({ id: 'e1', type: 'click', targetLabel: 'Go', selectorCandidates: ["locator('.btn')"] }),
      ]),
    );
    expect(spec.content).toContain('// TODO: fragile selector');
    expect(spec.selectorWarnings).toHaveLength(1);
    expect(spec.selectorWarnings[0]?.eventId).toBe('e1');
  });

  it('turns observed results into assertions', () => {
    const spec = buildPlaywrightSpec(
      session([
        ev({
          id: 'e1',
          type: 'click',
          selectorCandidates: ["getByRole('button', { name: 'Submit' })"],
          resultSummary: 'Release date is required',
        }),
      ]),
    );
    expect(spec.content).toContain(
      "await expect(page.getByText('Release date is required')).toBeVisible();",
    );
  });

  it('always produces a parseable import header', () => {
    const spec = buildPlaywrightSpec(session([]));
    expect(spec.content.startsWith("import { test, expect } from '@playwright/test';")).toBe(true);
  });
});
