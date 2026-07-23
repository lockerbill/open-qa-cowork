import { describe, expect, it } from 'vitest';
import {
  buildRunConfig,
  deriveSuggestedCases,
  formatSuggestedGoal,
  parseOrigins,
  parseTestCasesMarkdown,
  startBlocker,
  type SetupState,
} from './setup-logic.js';

const BASE: SetupState = {
  goal: 'Log in and create an item',
  mode: 'confirm',
  ackAutonomous: false,
  maxSteps: 25,
  origins: ['http://localhost:5555'],
};

describe('startBlocker', () => {
  it('allows a complete confirm-mode setup', () => {
    expect(startBlocker(BASE)).toBeNull();
  });

  it('requires a goal', () => {
    expect(startBlocker({ ...BASE, goal: '  ' })).toMatch(/goal/i);
  });

  it('requires at least one origin', () => {
    expect(startBlocker({ ...BASE, origins: [] })).toMatch(/origin/i);
  });

  it('blocks autonomous mode without the "I understand" ack (§10)', () => {
    expect(startBlocker({ ...BASE, mode: 'autonomous' })).toMatch(/I understand/);
  });

  it('allows autonomous mode once acknowledged', () => {
    expect(startBlocker({ ...BASE, mode: 'autonomous', ackAutonomous: true })).toBeNull();
  });

  it('does not require the ack outside autonomous mode', () => {
    expect(startBlocker({ ...BASE, mode: 'observe_only' })).toBeNull();
  });
});

describe('parseOrigins', () => {
  it('normalizes URLs to origins, drops invalid lines, dedupes', () => {
    expect(
      parseOrigins(
        'https://staging.example.com/some/path\nnot a url\n\nhttps://staging.example.com\nhttp://localhost:5555',
      ),
    ).toEqual(['https://staging.example.com', 'http://localhost:5555']);
  });
});

describe('buildRunConfig', () => {
  it('applies defaults and derives maxLlmCalls from maxSteps', () => {
    const config = buildRunConfig({ ...BASE, maxSteps: 30 });
    expect(config.maxSteps).toBe(30);
    expect(config.maxLlmCalls).toBe(40);
    expect(config.originAllowlist).toEqual(BASE.origins);
    expect(config.deciderBaseUrl).toBeUndefined();
  });

  it('carries the decider override only when set', () => {
    expect(buildRunConfig(BASE, ' http://localhost:5557 ').deciderBaseUrl).toBe(
      'http://localhost:5557',
    );
  });
});

describe('formatSuggestedGoal (§10 prefill format)', () => {
  it('renders title-only cases as the degenerate form', () => {
    expect(formatSuggestedGoal({ title: 'Login works' })).toBe('Test: Login works.');
  });

  it('renders the full Test/Steps/Expected format with numbered steps', () => {
    expect(
      formatSuggestedGoal({
        title: 'Create an item.',
        steps: ['Open the form', 'Fill the name.', 'Submit'],
        expected: 'Item appears in the list',
      }),
    ).toBe(
      'Test: Create an item. Steps: 1. Open the form. 2. Fill the name. 3. Submit. Expected: Item appears in the list.',
    );
  });
});

describe('parseTestCasesMarkdown', () => {
  const MARKDOWN = `# Test cases

## Login area

### TC-1: Login with valid credentials
- **Preconditions:** account exists
- **Steps:**
  1. Enter email
  2. Enter password
  3. Click Sign in
- **Expected Result:** dashboard is shown
- **Priority:** high

### TC-2: Login with wrong password
- **Steps:**
  - Enter email
  - Enter a wrong password
- **Expected Result:** an error message appears
`;

  it('parses cases with steps and expected results', () => {
    const cases = parseTestCasesMarkdown(MARKDOWN);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toEqual({
      title: 'Login with valid credentials',
      steps: ['Enter email', 'Enter password', 'Click Sign in'],
      expected: 'dashboard is shown',
    });
    expect(cases[1]!.title).toBe('Login with wrong password');
    expect(cases[1]!.steps).toHaveLength(2);
  });

  it('parses field-style cases without TC headings', () => {
    const cases = parseTestCasesMarkdown(
      ['- ID: TC-3', '- Title: Delete an item', '- Steps:', '  1. Click Delete', '- Expected: item gone'].join(
        '\n',
      ),
    );
    expect(cases).toEqual([
      { title: 'Delete an item', steps: ['Click Delete'], expected: 'item gone' },
    ]);
  });

  it('yields nothing for unstructured text', () => {
    expect(parseTestCasesMarkdown('Just some prose about testing.')).toEqual([]);
  });
});

describe('deriveSuggestedCases', () => {
  it('prefers parsed markdown cases', () => {
    const cases = deriveSuggestedCases('### TC-1: From markdown\n- Steps:\n  1. do it', ['ignored']);
    expect(cases[0]!.title).toBe('From markdown');
  });

  it('falls back to analyze one-liners as title-only cases', () => {
    expect(deriveSuggestedCases(null, ['Check validation'])).toEqual([
      { title: 'Check validation' },
    ]);
    expect(deriveSuggestedCases('no cases here', undefined)).toEqual([]);
  });
});
