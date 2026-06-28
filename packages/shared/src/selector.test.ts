import { describe, it, expect } from 'vitest';
import {
  rankSelectors,
  selectorStrings,
  isFragileLocator,
  bestStrategy,
  escapeForSingleQuotes,
} from './selector.js';

describe('rankSelectors priority ladder (spec §9.10)', () => {
  it('orders all strategies best-first', () => {
    const cands = rankSelectors({
      testId: 'submit-order',
      testAttr: 'submit',
      role: 'button',
      accessibleName: 'Submit',
      ariaLabel: 'Submit order',
      labelText: 'Submit form',
      visibleText: 'Submit',
      cssPath: '.btn.btn-primary',
      xpath: '//button[1]',
    });
    expect(cands.map((c) => c.strategy)).toEqual([
      'testid',
      'testattr',
      'role',
      'arialabel',
      'label',
      'text',
      'css',
      'xpath',
    ]);
  });

  it('prefers data-testid as the top candidate', () => {
    const [top] = rankSelectors({ testId: 'x', role: 'button', accessibleName: 'Go' });
    expect(top?.locator).toBe("getByTestId('x')");
    expect(top?.strategy).toBe('testid');
  });

  it('builds a role+name locator', () => {
    expect(selectorStrings({ role: 'button', accessibleName: 'Save Draft' })).toContain(
      "getByRole('button', { name: 'Save Draft' })",
    );
  });

  it('skips empty/whitespace inputs', () => {
    expect(rankSelectors({ testId: '   ', visibleText: 'Go' }).map((c) => c.strategy)).toEqual([
      'text',
    ]);
  });

  it('does not duplicate label when it equals aria-label', () => {
    const strategies = rankSelectors({ ariaLabel: 'Name', labelText: 'Name' }).map(
      (c) => c.strategy,
    );
    expect(strategies).toEqual(['arialabel']);
  });

  it('escapes single quotes in names', () => {
    const [top] = rankSelectors({ role: 'button', accessibleName: "O'Brien" });
    expect(top?.locator).toBe("getByRole('button', { name: 'O\\'Brien' })");
  });

  it('flags css and xpath as fragile only', () => {
    const cands = rankSelectors({ testId: 'a', cssPath: '.b', xpath: '//c' });
    expect(cands.find((c) => c.strategy === 'testid')?.fragile).toBe(false);
    expect(cands.find((c) => c.strategy === 'css')?.fragile).toBe(true);
    expect(cands.find((c) => c.strategy === 'xpath')?.fragile).toBe(true);
  });
});

describe('isFragileLocator', () => {
  it('treats role/label/testid as stable', () => {
    expect(isFragileLocator("getByRole('button', { name: 'X' })")).toBe(false);
    expect(isFragileLocator("getByTestId('x')")).toBe(false);
    expect(isFragileLocator("locator('[data-test=\"x\"]')")).toBe(false);
  });
  it('treats css and xpath as fragile', () => {
    expect(isFragileLocator("locator('.btn-primary')")).toBe(true);
    expect(isFragileLocator("locator('xpath=//button')")).toBe(true);
  });
});

describe('bestStrategy', () => {
  it('returns undefined when nothing is provided', () => {
    expect(bestStrategy({})).toBeUndefined();
  });
});

describe('escapeForSingleQuotes', () => {
  it('escapes backslashes and single quotes', () => {
    expect(escapeForSingleQuotes("a\\b'c")).toBe("a\\\\b\\'c");
  });

  it('escapes newlines and carriage returns so multi-line values stay single-line literals', () => {
    // A multi-line textarea value must not embed a literal newline in a single-quoted
    // JS string, or the generated Playwright spec fails to parse.
    expect(escapeForSingleQuotes('line1\nline2')).toBe('line1\\nline2');
    expect(escapeForSingleQuotes('line1\r\nline2')).toBe('line1\\r\\nline2');
    expect(escapeForSingleQuotes('line1\nline2')).not.toContain('\n');
  });
});
