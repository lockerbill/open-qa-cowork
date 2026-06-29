import { describe, it, expect } from 'vitest';
import { buildSessionMarkdown } from './sessionMarkdown.js';
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

describe('buildSessionMarkdown', () => {
  it('numbers steps with target label and value', () => {
    const md = buildSessionMarkdown(
      session([
        ev({ type: 'click', targetLabel: 'Submit button' }),
        ev({ type: 'input', targetLabel: 'Email field', valueText: 'a@b.com' }),
      ]),
    );
    expect(md).toContain('1. **click** → Submit button');
    expect(md).toContain('2. **input** → Email field: a@b.com');
  });

  it('hides sensitive values and never emits the literal', () => {
    const md = buildSessionMarkdown(
      session([ev({ type: 'input', targetLabel: 'Password', valueType: 'sensitive', value: 'hunter2' })]),
    );
    expect(md).toContain('**input** → Password (value hidden)');
    expect(md).not.toContain('hunter2');
  });

  it('renders resultSummary as a sub-line', () => {
    const md = buildSessionMarkdown(session([ev({ resultSummary: 'Validation error appeared' })]));
    expect(md).toContain('_Validation error appeared_');
  });

  it('includes console errors and network failures when present', () => {
    const md = buildSessionMarkdown(
      session([ev({})], {
        consoleErrors: [{ level: 'error', message: 'Boom', timestamp: '2026-06-27T10:02:00Z' }],
        networkFailures: [
          { method: 'POST', urlPath: '/api/orders', status: 500, reason: 'Server Error', timestamp: '2026-06-27T10:03:00Z' },
        ],
      }),
    );
    expect(md).toContain('### Console errors');
    expect(md).toContain('- [error] Boom');
    expect(md).toContain('### Network failures');
    expect(md).toContain('- POST /api/orders → 500 (Server Error)');
  });

  it('omits empty console and network sections', () => {
    const md = buildSessionMarkdown(session([ev({})]));
    expect(md).not.toContain('### Console errors');
    expect(md).not.toContain('### Network failures');
  });

  it('omits absent metadata fields but always shows totals', () => {
    const md = buildSessionMarkdown(
      session([], { browser: undefined, environment: undefined, baseUrl: undefined, currentUrl: undefined }),
    );
    expect(md).not.toContain('**Browser:**');
    expect(md).not.toContain('**Environment:**');
    expect(md).not.toContain('**URL:**');
    expect(md).toContain('**Totals:** 0 actions, 0 console, 0 network');
  });

  it('includes a metadata header with URL and browser when present', () => {
    const md = buildSessionMarkdown(session([ev({})], { browser: 'Chrome 130' }));
    expect(md).toContain('## QA Session');
    expect(md).toContain('- **URL:** https://staging.example.com/orders/create');
    expect(md).toContain('- **Browser:** Chrome 130');
  });
});
