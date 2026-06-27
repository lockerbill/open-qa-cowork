/**
 * Selector-candidate generation following the priority ladder in spec §9.10:
 *   1. data-testid  2. data-test  3. role + accessible name  4. aria-label
 *   5. associated label  6. stable visible text  7. CSS fallback  8. XPath
 *
 * Pure functions — no DOM dependency — so they are unit-testable in Node.
 * The content script extracts a `SelectorInput` from a live element and calls
 * `rankSelectors`.
 */

export type SelectorStrategy =
  | 'testid'
  | 'testattr'
  | 'role'
  | 'arialabel'
  | 'label'
  | 'text'
  | 'css'
  | 'xpath';

export interface SelectorCandidate {
  /** Playwright locator fragment, e.g. `getByRole('button', { name: 'Submit' })`. */
  locator: string;
  strategy: SelectorStrategy;
  fragile: boolean;
}

export interface SelectorInput {
  testId?: string;
  testAttr?: string;
  role?: string;
  accessibleName?: string;
  ariaLabel?: string;
  labelText?: string;
  visibleText?: string;
  /** A computed CSS path used only as a fallback. */
  cssPath?: string;
  /** A computed XPath used only as a last resort. */
  xpath?: string;
}

/** Escape a single-quoted string for embedding in generated locator code. */
export function escapeForSingleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function q(value: string): string {
  return `'${escapeForSingleQuotes(value)}'`;
}

/**
 * Return selector candidates ordered best-first per the spec ladder.
 * Empty/whitespace-only inputs for a strategy are skipped.
 */
export function rankSelectors(input: SelectorInput): SelectorCandidate[] {
  const out: SelectorCandidate[] = [];
  const has = (v?: string): v is string => typeof v === 'string' && v.trim().length > 0;

  if (has(input.testId)) {
    out.push({ locator: `getByTestId(${q(input.testId)})`, strategy: 'testid', fragile: false });
  }
  if (has(input.testAttr)) {
    out.push({
      locator: `locator('[data-test=${JSON.stringify(input.testAttr)}]')`,
      strategy: 'testattr',
      fragile: false,
    });
  }
  if (has(input.role) && has(input.accessibleName)) {
    out.push({
      locator: `getByRole('${input.role}', { name: ${q(input.accessibleName)} })`,
      strategy: 'role',
      fragile: false,
    });
  }
  if (has(input.ariaLabel)) {
    out.push({ locator: `getByLabel(${q(input.ariaLabel)})`, strategy: 'arialabel', fragile: false });
  }
  if (has(input.labelText) && input.labelText !== input.ariaLabel) {
    out.push({ locator: `getByLabel(${q(input.labelText)})`, strategy: 'label', fragile: false });
  }
  if (has(input.visibleText)) {
    out.push({ locator: `getByText(${q(input.visibleText)})`, strategy: 'text', fragile: false });
  }
  if (has(input.cssPath)) {
    out.push({ locator: `locator(${q(input.cssPath)})`, strategy: 'css', fragile: true });
  }
  if (has(input.xpath)) {
    out.push({
      locator: `locator('xpath=${escapeForSingleQuotes(input.xpath)}')`,
      strategy: 'xpath',
      fragile: true,
    });
  }
  return out;
}

/** Convenience: just the ordered locator strings, for `ElementInfo.selectorCandidates`. */
export function selectorStrings(input: SelectorInput): string[] {
  return rankSelectors(input).map((c) => c.locator);
}

/** Heuristic: is a raw locator fragment fragile (css/xpath/class-based)? */
export function isFragileLocator(locator: string): boolean {
  if (/xpath=/.test(locator)) return true;
  // Role/label/text/testid locators are stable.
  if (/^getBy/.test(locator)) return false;
  // `data-test` attribute selectors are stable too.
  if (/^locator\(\s*'\[data-test/.test(locator)) return false;
  // Any other raw CSS locator() is a fragile fallback.
  if (/^locator\(/.test(locator)) return true;
  return false;
}

/** The strongest available strategy, or undefined if none. */
export function bestStrategy(input: SelectorInput): SelectorStrategy | undefined {
  return rankSelectors(input)[0]?.strategy;
}
